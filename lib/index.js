/**
 * dsh-fans-notify-center — host half.
 *
 * Owns the truth about "what still needs the user": one card per session and
 * kind, created from the host's own session feed (no page required), resolved
 * when the thing that created it goes away.
 *
 * Sources:
 *   session/event 'turn/end'      → 已完成 / 出错
 *   approval/request  (waterfall) → 待审批, resolved when the answer settles
 *   user-questions/request        → 待回答 (plan review shows as 待审批)
 *
 * Delivery: `win/NotifyCenter.exe` polls GET /state and posts user actions back
 * to POST /action. The browser half picks up "open this session" from
 * GET /actions and reports sessions the user opened by hand to POST /seen.
 *
 * Nothing here is page-bound: closing or minimising DSH does not stop the
 * window from being updated.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/__dsh-notify-center'
const EXE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'win', 'NotifyCenter.exe')
const MAX_BODY = 64 * 1024
const MAX_ITEMS = 200
const MAX_ACTIONS = 64

const KIND_LABEL = {
	approval: '待审批',
	question: '待回答',
	done: '已完成',
	error: '出错',
}

const REASON_LABEL = {
	error: '本轮出错',
	aborted: '本轮中止',
	blocked: '本轮被拦截',
	interrupted: '本轮被中断',
	'max-tokens': '输出被截断',
}

function clamp(value, min, max, fallback) {
	const number = Number(value)
	if (!Number.isFinite(number)) return fallback
	return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeConfig(raw) {
	const config = raw !== null && typeof raw === 'object' ? raw : {}
	const kinds = config.kinds !== null && typeof config.kinds === 'object' ? config.kinds : {}
	const window = config.window !== null && typeof config.window === 'object' ? config.window : {}
	return {
		enabled: config.enabled !== false,
		includeSubagents: config.includeSubagents === true,
		done: kinds.done !== false,
		approval: kinds.approval !== false,
		question: kinds.question !== false,
		errors: kinds.errors !== false,
		theme: window.theme === 'light' || window.theme === 'dark' ? window.theme : 'auto',
		screen: window.screen === 'primary' ? 'primary' : 'dsh',
		bottomOffset: clamp(window.bottomOffset, 0, 400, 100),
		rightOffset: clamp(window.rightOffset, 0, 400, 8),
		cardOpacity: clamp(window.cardOpacity, 20, 100, 100),
		width: clamp(window.width, 260, 620, 360),
		maxVisible: clamp(window.maxVisible, 1, 20, 6),
		log: window.log === true,
		test: config.test !== false,
	}
}

/**
 * The profile directory this Host runs from. The settings page writes its file
 * here, so the values survive plugin updates and Host restarts.
 * @returns the absolute profile directory.
 */
function profileDirectory() {
	const explicit = process.env.DSH_PROFILE_DIR
	if (typeof explicit === 'string' && explicit.length > 0) return explicit
	const name = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : 'desktop'
	return path.join(homedir(), '.dsh', 'profiles', name)
}

/**
 * @param file - the config file.
 * @returns its parsed object, or an empty object when it is missing or broken.
 */
function readConfigFile(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

/**
 * @param file - the config file.
 * @param value - the object to persist.
 */
function writeConfigFile(file, value) {
	const temporary = file + '.tmp'
	writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
	renameSync(temporary, file)
}

/**
 * The persisted shape, which is also what the settings page edits.
 * @param config - the flat runtime config.
 * @returns the nested file object.
 */
function fileShape(config) {
	return {
		enabled: config.enabled,
		includeSubagents: config.includeSubagents,
		kinds: { done: config.done, approval: config.approval, question: config.question, errors: config.errors },
		window: { bottomOffset: config.bottomOffset, rightOffset: config.rightOffset, cardOpacity: config.cardOpacity, theme: config.theme, screen: config.screen, width: config.width, maxVisible: config.maxVisible },
		test: config.test,
	}
}

/**
 * Answer a request with JSON. Route handlers own the response.
 * @param res - the node response.
 * @param status - HTTP status.
 * @param body - JSON-serialisable payload.
 */
function send(res, status, body) {
	const payload = JSON.stringify(body)
	try {
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(payload),
		})
		res.end(payload)
	} catch {
		// The client hung up mid-render; nothing left to do.
	}
}

/**
 * Only the machine itself may touch these routes.
 * @param req - the incoming request.
 * @returns true for a loopback peer.
 */
function isLoopback(req) {
	const address = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '')
	return address === '127.0.0.1' || address === '::1' || address === '';
}

/**
 * Read a small JSON body.
 * @param req - the incoming request.
 * @returns the parsed body, or null when it is missing or malformed.
 */
function readJson(req) {
	return new Promise((resolve) => {
		let raw = ''
		let settled = false
		const finish = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
		req.on('data', (chunk) => {
			raw += chunk
			if (raw.length > MAX_BODY) {
				finish(null)
				req.destroy()
			}
		})
		req.on('end', () => {
			if (raw.length === 0) return finish({})
			try {
				const parsed = JSON.parse(raw)
				finish(parsed !== null && typeof parsed === 'object' ? parsed : null)
			} catch {
				finish(null)
			}
		})
		req.on('error', () => finish(null))
	})
}

/**
 * Normalize `turn/end`'s reason, which is an object in current logs and a bare
 * string in older ones.
 * @param reason - `event.data.reason`.
 * @returns the reason kind, or an empty string.
 */
function reasonKind(reason) {
	if (typeof reason === 'string') return reason
	if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
	return ''
}

export function apply(ctx, rawConfig) {
	// The settings page (this plugin's row on the Plugins page) writes a JSON
	// file in the profile; the loader row config is the base it overrides.
	const configFile = path.join(profileDirectory(), 'notify-center.config.json')
	const stored = readConfigFile(configFile)
	const config = normalizeConfig({ ...(rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}), ...stored })
	if (!config.enabled) return

	const token = randomBytes(16).toString('hex')
	const items = new Map()
	const actions = []
	const sessions = new Map()
	let version = 1
	let actionSeq = 0
	let child = null
	let warnedMissingExe = false
	let stateOrigin = null
	// 浏览器半上报的 DSH 页面主题（light/dark）；空 = 页面还没上报过。
	let dshTheme = ''
	const stats = { clientPolls: 0, lastClientPollAt: 0, seenReports: 0, opens: 0, sessionEvents: 0, turnEnds: 0, created: 0, disposed: 0, clientEvents: {} }

	// 配色=auto 时的实际取值：优先 DSH 页面主题，页面没上报过再让窗口读 Windows 主题。
	const resolvedTheme = () =>
		config.theme === 'auto' && (dshTheme === 'light' || dshTheme === 'dark') ? dshTheme : config.theme

	const changed = () => {
		version += 1
		if (items.size > 0) ensureWindow()
	}

	// Fingerprint of every window-launch argument. The window polls it with the
	// state; when it changes, the window exits itself and the host respawns with
	// the new arguments. This — not child.kill(), whose async termination races
	// with the single-instance mutex — is what makes 保存配置 take effect.
	const windowSignature = () =>
		[resolvedTheme(), config.bottomOffset, config.rightOffset, config.cardOpacity, config.screen, config.width, config.maxVisible].join('|')

	/**
	 * Remember a live session so approval/question cards can name it.
	 * @param session - the Session instance.
	 */
	const rememberSession = (session) => {
		const id = String(session?.id ?? '')
		if (id.length > 0) sessions.set(id, session)
	}

	/**
	 * Resolve a session for a request that only carries an agent id.
	 * @param sessionId - the session id.
	 * @returns a Session-like object, never null.
	 */
	const sessionOf = (sessionId) => {
		const known = sessions.get(sessionId)
		if (known) return known
		try {
			const agent = ctx.get('agents')?.get?.(sessionId)
			if (agent?.session) {
				rememberSession(agent.session)
				return agent.session
			}
		} catch {
			// An agent may already be gone; the fallback still renders a card.
		}
		return { id: sessionId, header: {} }
	}

	/**
	 * @param session - the session the card belongs to.
	 * @returns the title to show on the card.
	 */
	const titleOf = (session) => {
		try {
			const snapshot = ctx.get('sessionTitle')?.get?.(session)
			if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string' && snapshot.title.length > 0) {
				return snapshot.title
			}
		} catch {
			// No title service, or the session is unknown to it.
		}
		const cwd = session?.header?.cwd
		if (typeof cwd === 'string' && cwd.length > 0) {
			const base = path.basename(cwd)
			if (base.length > 0) return base
		}
		const id = String(session?.id ?? '')
		return id.length > 0 ? `会话 ${id.slice(0, 8)}` : '会话'
	}

	/**
	 * @param session - the session the card belongs to.
	 * @returns the workspace title, or an empty string when ungrouped.
	 */
	const workspaceOf = (session) => {
		const cwd = session?.header?.cwd
		if (typeof cwd !== 'string' || cwd.length === 0) return ''
		try {
			const list = ctx.get('workspaceRegistry')?.list?.() ?? []
			let best = null
			for (const workspace of list) {
				const root = String(workspace?.path ?? '')
				if (root.length === 0) continue
				if (cwd === root || cwd.startsWith(root + path.sep) || cwd.startsWith(root + '/')) {
					if (best === null || root.length > String(best.path ?? '').length) best = workspace
				}
			}
			if (best) {
				const title = String(best.title ?? '').trim()
				return title.length > 0 ? title : path.basename(String(best.path ?? ''))
			}
		} catch {
			// The registry is optional; ungrouped cards are still useful.
		}
		return ''
	}

	const allowed = (kind) => {
		if (kind === 'done') return config.done
		if (kind === 'error') return config.errors
		if (kind === 'approval') return config.approval
		if (kind === 'question') return config.question
		return true
	}

	/**
	 * Create or refresh one card.
	 * @param session - the session it belongs to.
	 * @param kind - 'done' | 'error' | 'approval' | 'question'.
	 * @param detail - short second-line hint (tool name, question header, …).
	 * @returns the card key, or null when the card is not wanted.
	 */
	const upsert = (session, kind, detail) => {
		if (!allowed(kind)) return null
		const sessionId = String(session?.id ?? '')
		if (sessionId.length === 0) return null
		if (session?.header?.origin === 'subagent' && !config.includeSubagents) return null
		const key = sessionId + ':' + kind
		items.set(key, {
			id: key,
			kind,
			sessionId,
			title: titleOf(session),
			workspace: workspaceOf(session),
			detail: typeof detail === 'string' ? detail : '',
			time: Date.now(),
		})
		stats.created += 1
		if (items.size > MAX_ITEMS) {
			const oldest = items.keys().next().value
			items.delete(oldest)
		}
		changed()
		return key
	}

	const remove = (key) => {
		if (typeof key !== 'string') return
		if (items.delete(key)) changed()
	}

	const removeSession = (sessionId) => {
		let touched = false
		for (const [key, item] of items) {
			if (item.sessionId !== sessionId) continue
			items.delete(key)
			touched = true
		}
		if (touched) changed()
	}

	// ── alert sources ───────────────────────────────────────────────────

	const onSessionEvent = (session, event) => {
		try {
			stats.sessionEvents += 1
			rememberSession(session)
			const sessionId = String(session?.id ?? '')
			const type = event?.type
			if (type === 'turn/start') {
				// A new turn means the previous finish notice is stale.
				remove(sessionId + ':done')
				remove(sessionId + ':error')
				return
			}
			if (type !== 'turn/end') return
			stats.turnEnds += 1
			const reason = reasonKind(event?.data?.reason)
			const cancel = event?.data?.reason?.reason?.kind
			if (reason === 'forked') return
			if (reason === 'aborted' && (cancel === 'user' || cancel === 'parent' || cancel === 'disposed')) return
			if (reason === 'error' || reason === 'blocked' || reason === 'interrupted') {
				remove(sessionId + ':done')
				upsert(session, 'error', REASON_LABEL[reason] ?? '')
				return
			}
			if (reason === 'aborted') {
				remove(sessionId + ':done')
				upsert(session, 'error', REASON_LABEL.aborted)
				return
			}
			remove(sessionId + ':error')
			upsert(session, 'done', REASON_LABEL[reason] ?? '')
		} catch (error) {
			ctx.logger?.warn?.(`dsh-notify-center: turn/end handling failed: ${error?.message ?? String(error)}`)
		}
	}

	// The two waterfall handlers below sit in front of the real answerers. They
	// must always delegate: a card is worth nothing if collecting it can stop an
	// approval from ever reaching the page.
	const onApproval = async (request, next) => {
		let key = null
		try {
			const sessionId = String(request?.agent?.id ?? '')
			if (sessionId.length > 0) key = upsert(sessionOf(sessionId), 'approval', describeApproval(request))
		} catch (error) {
			ctx.logger?.warn?.(`dsh-notify-center: approval card failed: ${error?.message ?? String(error)}`)
		}
		try {
			return await next()
		} finally {
			try {
				remove(key)
			} catch {
				// The card is best-effort at this point.
			}
		}
	}

	const onQuestion = async (request, next) => {
		let key = null
		try {
			const sessionId = String(request?.agent?.id ?? '')
			if (sessionId.length > 0) {
				const plan = Array.isArray(request?.questions) && request.questions.some((question) => question?.intent?.kind === 'plan-review')
				key = upsert(sessionOf(sessionId), plan ? 'approval' : 'question', plan ? '计划待确认' : describeQuestion(request))
			}
		} catch (error) {
			ctx.logger?.warn?.(`dsh-notify-center: question card failed: ${error?.message ?? String(error)}`)
		}
		try {
			return await next()
		} finally {
			try {
				remove(key)
			} catch {
				// The card is best-effort at this point.
			}
		}
	}

	ctx.effect(
		() => {
			const offs = [
				ctx.on('session/event', onSessionEvent),
				ctx.on('session/disposed', (session) => {
					const id = String(session?.id ?? '')
					stats.disposed += 1
					sessions.delete(id)
					removeSession(id)
				}),
				ctx.on('approval/request', onApproval),
				ctx.on('user-questions/request', onQuestion),
			]
			return () => {
				for (const off of offs) {
					try {
						off?.()
					} catch {
						// Already disposed by an outer scope.
					}
				}
			}
		},
		'dsh-notify-center: alert sources',
	)

	// ── window process ──────────────────────────────────────────────────

		let retryTimer = null
		let retryCount = 0

		function ensureWindow() {
			if (retryTimer !== null) return
			if (child !== null) return
			if (stateOrigin === null) return
			if (!existsSync(EXE)) {
				if (!warnedMissingExe) {
					warnedMissingExe = true
					ctx.logger?.warn?.(`dsh-notify-center: ${EXE} is missing — run win/build.ps1 to build the window`)
				}
				return
			}
			const argv = [
				'--state-url', stateOrigin + ROUTE + '/state',
				'--action-url', stateOrigin + ROUTE + '/action',
				'--token', token,
				'--theme', resolvedTheme(),
				'--screen', config.screen,
				'--bottom-offset', String(config.bottomOffset),
				'--right-offset', String(config.rightOffset),
				'--card-opacity', String(config.cardOpacity),
				'--width', String(config.width),
				'--max-visible', String(config.maxVisible),
			]
			if (config.log) argv.push('--log', path.join(tmpdir(), 'dsh-notify-center-window.log'))
			try {
				const spawnedAt = Date.now()
				const spawned = spawn(EXE, argv, { windowsHide: true, stdio: 'ignore' })
				child = spawned
				spawned.on('exit', () => {
					// Only the current handle may clear itself: a stale child's late
					// exit event must not drop the replacement spawned after it.
					if (child !== spawned) return
					child = null
					// A window that dies within seconds of spawning usually means
					// the single-instance lock is still held by the previous host
					// generation's window (hot plugin reload). That window quits on
					// its next 403, so retry a few times instead of waiting for the
					// 15 s watchdog.
					if (items.size > 0 && Date.now() - spawnedAt < 2500 && retryCount < 8) {
						retryCount += 1
						retryTimer = setTimeout(() => {
							retryTimer = null
							ensureWindow()
						}, 2500)
					}
				})
				spawned.on('error', (error) => {
					if (child === spawned) child = null
					ctx.logger?.warn?.(`dsh-notify-center: window failed to start: ${error?.message ?? String(error)}`)
				})
			} catch (error) {
				child = null
				ctx.logger?.warn?.(`dsh-notify-center: window failed to start: ${error?.message ?? String(error)}`)
			}
		}

		function stopWindow() {
			if (retryTimer !== null) {
				clearTimeout(retryTimer)
				retryTimer = null
			}
			retryCount = 0
			const running = child
			child = null
			try {
				running?.kill()
			} catch {
				// The process may have exited on its own.
			}
		}

	ctx.effect(() => () => {
		stopWindow()
	}, 'dsh-notify-center: window lifetime')

	/**
	 * Apply a settings-page patch: persist it, drop cards whose kind was just
	 * turned off, and restart the window so size, theme, and screen take effect.
	 * @param patch - the nested file shape from the settings page.
	 * @returns the effective config.
	 */
	function applyConfigLive(patch) {
		const previous = fileShape(config)
		const incoming = patch !== null && typeof patch === 'object' ? patch : {}
		// Deep-merge the nested groups: a partial patch (e.g. only the anchor)
		// must not reset sibling fields to their defaults.
		const merged = {
			...previous,
			...incoming,
			kinds: { ...previous.kinds, ...(incoming.kinds ?? {}) },
			window: { ...previous.window, ...(incoming.window ?? {}) },
		}
		const next = normalizeConfig(merged)
		Object.assign(config, next)
		try {
			writeConfigFile(configFile, fileShape(config))
		} catch (error) {
			ctx.logger?.warn?.(`dsh-notify-center: could not save ${configFile}: ${error?.message ?? String(error)}`)
		}
		let changedCards = false
		for (const [key, item] of items) {
			if (allowed(item.kind)) continue
			items.delete(key)
			changedCards = true
		}
		if (changedCards) version += 1
		// Best-effort kill; the authoritative switch is the config fingerprint in
		// /state — the window sees it change and exits itself, and the respawn
		// (here or via the exit-retry) starts with the new arguments.
		stopWindow()
		if (items.size > 0) ensureWindow()
		return fileShape(config)
	}

	// A window that died (crash, logout, manual kill) comes back while cards
	// are still pending; an idle show with no cards would be noise.
	ctx.effect(() => {
		const watchdog = setInterval(() => {
			if (items.size > 0) ensureWindow()
		}, 15000)
		return () => clearInterval(watchdog)
	}, 'dsh-notify-center: window watchdog')

	// ── routes ──────────────────────────────────────────────────────────

	ctx.inject(['webServer'], (webCtx) => {
		let origin = null
		try {
			origin = webCtx.webServer.getOrigin()
		} catch {
			origin = null
		}
		if (typeof origin === 'string' && origin.length > 0) stateOrigin = origin.replace(/\/$/, '')
		if (items.size > 0) ensureWindow()

		const route = (suffix, handler, label) =>
			webCtx.effect(
				() => webCtx.webServer.register({ kind: 'exact', path: ROUTE + suffix, handler }),
				`dsh-notify-center: ${label}`,
			)

		// The window's read side.
		route('/state', (req, res) => {
			if (req.method !== 'GET') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			const supplied = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
			if (supplied !== token) return send(res, 403, { ok: false, reason: 'bad-token' })
			const ordered = Array.from(items.values()).sort((a, b) => a.time - b.time)
			send(res, 200, { version, theme: resolvedTheme(), sig: windowSignature(), items: ordered })
		}, 'state route')

		// The window's write side: dismiss / clear / open.
		route('/action', async (req, res) => {
			if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			const body = await readJson(req)
			if (body === null) return send(res, 400, { ok: false, reason: 'bad-body' })
			if (body.token !== token) return send(res, 403, { ok: false, reason: 'bad-token' })
			const action = String(body.action ?? '')
			const id = typeof body.id === 'string' ? body.id : ''
			if (action === 'dismiss') {
				remove(id)
				return send(res, 200, { ok: true, version })
			}
			if (action === 'clear') {
				if (items.size > 0) {
					items.clear()
					changed()
				}
				return send(res, 200, { ok: true, version })
			}
			if (action === 'open') {
				const item = items.get(id)
				if (item) {
					actions.push({ seq: ++actionSeq, action: 'open', sessionId: item.sessionId })
					while (actions.length > MAX_ACTIONS) actions.shift()
					stats.opens += 1
					remove(id)
				}
				return send(res, 200, { ok: true, version })
			}
			return send(res, 400, { ok: false, reason: 'unknown-action' })
		}, 'action route')

		// Browser half: drain "open this session" commands.
		route('/actions', (req, res) => {
			if (req.method !== 'GET') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			stats.clientPolls += 1
			stats.lastClientPollAt = Date.now()
			const after = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('after') ?? '0')
			const cursor = Number.isFinite(after) ? after : 0
			send(res, 200, {
				cursor: actionSeq,
				actions: actions.filter((entry) => entry.seq > cursor),
			})
		}, 'actions route')

		// Browser half: the user opened a session by hand (or finished with it),
		// so its cards are no longer waiting for attention.
		route('/seen', async (req, res) => {
			if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			const body = await readJson(req)
			if (body === null) return send(res, 400, { ok: false, reason: 'bad-body' })
			const ids = Array.isArray(body.sessionIds) ? body.sessionIds : []
			for (const id of ids) removeSession(String(id))
			stats.seenReports += ids.length
			send(res, 200, { ok: true, version })
		}, 'seen route')

		// Browser half: one-line reports that are useful when something looks
		// wrong (today: whether dsh-notify-me's system notifications got muted).
		route('/client-event', async (req, res) => {
			if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			const body = await readJson(req)
			if (body === null) return send(res, 400, { ok: false, reason: 'bad-body' })
			const name = String(body.name ?? '').slice(0, 40)
			// DSH 页面主题上报：配色=auto 时驱动弹窗明暗跟随（重生窗口带新 --theme）。
			if (name === 'dsh-theme') {
				const value = String(body.detail ?? '')
				if (value === 'light' || value === 'dark') {
					const changedTheme = dshTheme !== value
					dshTheme = value
					if (changedTheme && config.theme === 'auto' && items.size > 0) {
						stopWindow()
						ensureWindow()
					}
					return send(res, 200, { ok: true, dshTheme })
				}
			}
			if (name.length > 0) stats.clientEvents[name] = String(body.detail ?? '').slice(0, 80)
			send(res, 200, { ok: true })
		}, 'client event route')

		// Verification hook: inject sample cards without waiting for a real turn
		// to end, and clear them again — the settings page's 测试弹窗 buttons use
		// this. Clear only ever removes test-* cards, never real notifications.
		if (config.test) {
			route('/test', async (req, res) => {
				if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
				if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
				const body = (await readJson(req)) ?? {}
				if (body.clear === true) {
					let removed = 0
					for (const key of Array.from(items.keys())) {
						if (key.startsWith('test-')) {
							items.delete(key)
							removed += 1
						}
					}
					if (removed > 0) changed()
					return send(res, 200, { ok: true, cleared: removed, version })
				}
				const stamp = Date.now()
				const samples = [
					{ kind: 'approval', title: '示例：待审批的会话', detail: 'pwsh', workspace: '示例工作区' },
					{ kind: 'question', title: '示例：等待你回答', detail: '选择下一步', workspace: '示例工作区' },
					{ kind: 'done', title: '示例：回复已完成', detail: '', workspace: '示例工作区' },
				]
				const count = clamp(body.count, 1, 3, 1)
				for (let index = 0; index < count; index += 1) {
					const sample = samples[index % samples.length]
					const sessionId = `test-${stamp}-${index}`
					items.set(sessionId + ':' + sample.kind, {
						id: sessionId + ':' + sample.kind,
						kind: sample.kind,
						sessionId,
						title: sample.title,
						workspace: sample.workspace,
						detail: sample.detail,
						time: stamp - index,
					})
				}
				changed()
				send(res, 200, { ok: true, injected: count, version })
			}, 'test route')
		}

		// This plugin's own settings page (Plugins → fans通知弹窗中心 → 配置).
		// Deliberately not a Settings namespace: the options live here and nowhere
		// else, which is also why they are persisted by this plugin, not by DSH.
		route('/config', async (req, res) => {
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			if (req.method === 'GET') {
				return send(res, 200, { ok: true, config: fileShape(config), file: configFile })
			}
			if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			const body = await readJson(req)
			if (body === null) return send(res, 400, { ok: false, reason: 'bad-body' })
			const applied = applyConfigLive(body.config !== null && typeof body.config === 'object' ? body.config : body)
			send(res, 200, { ok: true, config: applied })
		}, 'config route')

		// Debug probe: what does the host think is pending right now.
		route('/status', (req, res) => {
			if (req.method !== 'GET') return send(res, 405, { ok: false, reason: 'method-not-allowed' })
			if (!isLoopback(req)) return send(res, 403, { ok: false, reason: 'bad-remote' })
			send(res, 200, {
				ok: true,
				version,
				items: Array.from(items.values()),
				window: child === null ? 'stopped' : 'running',
				exe: EXE,
				exeExists: existsSync(EXE),
				origin: stateOrigin,
				queue: actions.length,
				dshTheme,
				config: fileShape(config),
				configFile,
				stats,
			})
		}, 'status route')
	})
}

// ── small describers ────────────────────────────────────────────────────

/**
 * @param request - ApprovalRequestEvent.
 * @returns the tool name, plus the localized reason when the host supplied one.
 */
function describeApproval(request) {
	const tool = typeof request?.toolName === 'string' && request.toolName.length > 0 ? request.toolName : '工具调用'
	const display = request?.displayReason
	if (display !== null && typeof display === 'object') {
		const text = typeof display.zh === 'string' ? display.zh : typeof display.en === 'string' ? display.en : ''
		if (text.length > 0) return `${tool} · ${text.slice(0, 40)}`
	}
	const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
	return reason.length > 0 ? `${tool} · ${reason.slice(0, 40)}` : tool
}

/**
 * @param request - AskUserQuestionRequestEvent.
 * @returns the first question's header or text.
 */
function describeQuestion(request) {
	const first = Array.isArray(request?.questions) && request.questions.length > 0 ? request.questions[0] : null
	if (first === null) return '等待回答'
	const text = String(first.header ?? '').trim() || String(first.question ?? '').trim()
	return text.length > 0 ? text.slice(0, 40) : '等待回答'
}

export const name = 'dsh-fans-notify-center'
