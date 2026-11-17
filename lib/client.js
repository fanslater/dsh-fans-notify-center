/**
 * dsh-fans-notify-center — browser half.
 *
 * Three jobs, all invisible except the third:
 *   1. Drain the host's "open this session" queue (a card was clicked in the
 *      desktop window) and switch the shell to that session.
 *   2. Report sessions the user finished with by hand, so their cards leave the
 *      stack without an extra click.
 *   3. Render this plugin's own configuration page on the bundle's Plugins page
 *      (`plugins.bundle.config`, key = the package name), between the bundle's
 *      description and its component rows. The options live there and nowhere
 *      else — deliberately not a Settings namespace, and not on the component
 *      row either (`plugins.row.config` is for bundles that declare several
 *      rows, each needing its own form).
 */

window.__ModuleLoader__.load({
	id: "dsh-fans-notify-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const ROUTE = "/__dsh-notify-center";
		const POLL_MS = 2000;
		// `plugins.bundle.config` is keyed by the bundle's package name and renders
		// on the bundle page itself, right below its description. The alternative,
		// `plugins.row.config`, is keyed `<package>#<rowId>` and renders inside the
		// component row — the right place only for a bundle that declares several
		// rows with different forms.
		const CONFIG_SLOT = "plugins.bundle.config";
		const CONFIG_KEY = "dsh-fans-notify-center";

		// dsh-notify-me keeps its switches in this origin's localStorage: its
		// "启用提醒" master switch is `enabled` in this key. Turning it off once
		// (and remembering that we did) is what keeps two notification systems
		// from firing at the same time; turning it back on in its own settings
		// stays possible because this never runs twice.
		const NOTIFY_ME_CONFIG = "dshNotifyMe.config";
		const NOTIFY_ME_MARKER = "dsh-notify-center.silenced-notify-me";

		// Command cursor and the previous attention snapshot live for the life of
		// the page, not for one apply() call: a plugin reload must not replay old
		// commands or re-report sessions it already reported. A cursor of null
		// means "not primed yet" — the first successful poll swallows history and
		// only honours the newest command, which is the one just clicked.
		let cursor = null;
		let previous = new Map();
		let lastPageTheme = "";

		function service(ctx, name) {
			try {
				return ctx.get(name);
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * One-shot: silence dsh-notify-me's system notifications.
		 * @returns 'applied' | 'already' | 'done-before' | 'blocked'
		 */
		function silenceNotifyMe() {
			try {
				if (localStorage.getItem(NOTIFY_ME_MARKER) === "1") return "done-before";
				let config = {};
				const raw = localStorage.getItem(NOTIFY_ME_CONFIG);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
				}
				if (config.enabled === false) {
					localStorage.setItem(NOTIFY_ME_MARKER, "1");
					return "already";
				}
				config.enabled = false;
				localStorage.setItem(NOTIFY_ME_CONFIG, JSON.stringify(config));
				localStorage.setItem(NOTIFY_ME_MARKER, "1");
				return "applied";
			} catch (error) {
				/* private mode / blocked storage: the user can still flip it by hand */
				return "blocked";
			}
		}

		function snapshotOf(ctx) {
			const uiSession = service(ctx, "uiSession");
			const store = uiSession && uiSession.sessionStatus;
			const snapshot = store && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
			return snapshot instanceof Map ? snapshot : new Map();
		}

		function hasAttention(status) {
			if (!status) return false;
			const kind = status.pendingInteraction && status.pendingInteraction.kind;
			return Boolean(kind) || status.completionUnread === true;
		}

		async function drainCommands(ctx) {
			const after = cursor === null ? 0 : cursor;
			let response;
			try {
				response = await fetch(ROUTE + "/actions?after=" + after, { headers: { accept: "application/json" } });
			} catch (error) {
				return;
			}
			if (!response.ok) return;
			let body;
			try {
				body = await response.json();
			} catch (error) {
				return;
			}
			const queue = Array.isArray(body.actions) ? body.actions : [];
			if (typeof body.cursor === "number") cursor = body.cursor;
			const uiWorkspace = service(ctx, "uiWorkspace");
			if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") return;
			// First poll after a page load: everything in the queue predates it, so
			// only the last click is still what the user expects to see.
			const relevant = after === 0 && cursor !== null && queue.length > 1 ? queue.slice(-1) : queue;
			for (const entry of relevant) {
				if (!entry || entry.action !== "open" || typeof entry.sessionId !== "string") continue;
				try {
					uiWorkspace.openSession(entry.sessionId);
				} catch (error) {
					/* The session may be gone; nothing to open. */
				}
			}
		}

		function reportSeen(ctx) {
			const current = snapshotOf(ctx);
			const done = [];
			for (const [sessionId, status] of previous) {
				if (!hasAttention(status)) continue;
				if (hasAttention(current.get(sessionId))) continue;
				done.push(sessionId);
			}
			previous = new Map(current);
			if (done.length === 0) return;
			fetch(ROUTE + "/seen", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionIds: done }),
			}).catch(() => {});
		}

		async function tick(ctx) {
			await drainCommands(ctx);
			reportSeen(ctx);
			// DSH 主题变化（含第三方主题包）→ 报给宿主，弹窗随之明暗切换。
			const pageTheme = detectPageTheme();
			if (pageTheme && pageTheme !== lastPageTheme) {
				lastPageTheme = pageTheme;
				fetch(ROUTE + "/client-event", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "dsh-theme", detail: pageTheme }),
				}).catch(() => {});
			}
		}

		// ── settings page ─────────────────────────────────────────────────

		const styles = {
			page: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 620, color: "inherit" },
			intro: { fontSize: 12.5, lineHeight: 1.7, opacity: 0.72, margin: 0 },
			group: { display: "flex", flexDirection: "column", gap: 10 },
			groupTitle: { fontSize: 12, fontWeight: 600, letterSpacing: 0.4, opacity: 0.55, margin: "4px 0 0" },
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 16,
				padding: "8px 10px",
				border: "1px solid rgba(127,127,127,0.28)",
				borderRadius: 8,
			},
			rowText: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
			label: { fontSize: 13 },
			hint: { fontSize: 11.5, opacity: 0.55, lineHeight: 1.5 },
			control: { flex: "0 0 auto", fontSize: 13 },
			number: { width: 76, fontSize: 13, padding: "3px 6px", color: "inherit", background: "transparent", border: "1px solid rgba(127,127,127,0.35)", borderRadius: 6 },
			select: { fontSize: 13, padding: "3px 6px", color: "inherit", background: "transparent", border: "1px solid rgba(127,127,127,0.35)", borderRadius: 6 },
			footer: { display: "flex", alignItems: "center", gap: 12 },
			// 与 fans 系列插件配置页一致的按钮样式（session-monitor 的 button/buttonPrimary）。
			footerButton: {
				outline: "none",
				padding: "6px 12px",
				borderRadius: 6,
				border: "1px solid rgba(127,127,127,0.35)",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				cursor: "pointer",
				flexShrink: 0,
			},
			primaryButton: {
				outline: "none",
				padding: "6px 12px",
				borderRadius: 6,
				border: "1px solid rgba(47,107,255,0.9)",
				background: "rgba(47,107,255,0.92)",
				color: "#ffffff",
				font: "inherit",
				fontWeight: 600,
				cursor: "pointer",
				flexShrink: 0,
			},
			statusLine: { fontSize: 12, opacity: 0.65, minHeight: 18, margin: "-6px 0 0", textAlign: "right" },
			formHintText: { fontSize: 11, opacity: 0.6, margin: 0, alignSelf: "center" },
		};

		const DEFAULT_FORM = {
			enabled: true,
			includeSubagents: false,
			kinds: { done: true, approval: true, question: true, errors: true },
			window: { bottomOffset: 100, rightOffset: 8, cardOpacity: 100, theme: "auto", screen: "dsh", width: 360, maxVisible: 6 },
		};

		// Key-order-independent deep compare, for the dirty indicator.
		function stableStringify(value) {
			if (value === null || typeof value !== "object") return JSON.stringify(value);
			if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
			const keys = Object.keys(value).sort();
			return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
		}

		function row(label, hint, control) {
			return h(
				"div",
				{ style: styles.row, key: label },
				h("span", { style: styles.rowText }, h("span", { style: styles.label }, label), hint ? h("span", { style: styles.hint }, hint) : null),
				h("span", { style: styles.control }, control),
			);
		}

		function checkbox(checked, onChange) {
			return h("input", { type: "checkbox", checked: checked === true, onChange: (event) => onChange(event.target.checked) });
		}

		// 读页面根元素的计算背景亮度，判定 DSH 当前是浅色还是深色主题。
		// 对任何主题包都成立（不依赖主题名）；theme 服务没有变更推送，靠 2s 轮询。
		function detectPageTheme() {
			try {
				var probe = document.body || document.documentElement;
				var bg = getComputedStyle(probe).backgroundColor;
				var match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
				if (!match) return "";
				var luminance = (0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])) / 255;
				return luminance >= 0.5 ? "light" : "dark";
			} catch (error) {
				return "";
			}
		}

		function ConfigPage(props) {
			const [config, setConfig] = React.useState(null);
			const [saved, setSaved] = React.useState(null);
			const [status, setStatus] = React.useState("loading");
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				let alive = true;
				fetch(ROUTE + "/config", { headers: { accept: "application/json" } })
					.then((response) => response.json())
					.then((body) => {
						if (!alive) return;
						if (body && body.config) {
							setConfig(body.config);
							setSaved(body.config);
							setStatus("ready");
						} else {
							setError("宿主没有返回配置");
							setStatus("error");
						}
					})
					.catch(() => {
						if (!alive) return;
						setError("读取配置失败，通知中心宿主可能没有加载");
						setStatus("error");
					});
				return () => {
					alive = false;
				};
			}, []);

			if (props.view === "summary") {
				return h("span", null, "屏幕右下角的常驻通知弹窗：回合完成 / 待审批 / 待回答，逐条关闭");
			}

			if (status === "loading") return h("p", { style: styles.intro }, "正在读取配置…");
			if (status === "error" || !config) return h("p", { style: styles.intro }, error || "配置不可用");

			const update = (next) => setConfig(Object.assign({}, config, next));
			const updateKind = (name, value) =>
				update({ kinds: Object.assign({}, config.kinds, { [name]: value }) });
			const updateWindow = (name, value) =>
				update({ window: Object.assign({}, config.window, { [name]: value }) });

			const reset = () => {
				setConfig((previous) =>
					Object.assign({}, previous, DEFAULT_FORM, {
						kinds: Object.assign({}, DEFAULT_FORM.kinds),
						window: Object.assign({}, DEFAULT_FORM.window),
					}),
				);
				setStatus("ready");
				setError("");
			};

			const save = async () => {
				setStatus("saving");
				try {
					const response = await fetch(ROUTE + "/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ config }),
					});
					const body = await response.json();
					if (body && body.ok && body.config) {
						setConfig(body.config);
						setSaved(body.config);
						setStatus("saved");
					} else {
						setStatus("error");
						setError("保存失败");
					}
				} catch (fetchError) {
					setStatus("error");
					setError("保存失败：" + String((fetchError && fetchError.message) || fetchError));
				}
			};

			// 弹窗只在有卡片时出现，所以改锚点/偏移后没通知就“看不见效果”——
			// 这两个按钮用 /test 接口即时发 3 张示例卡、或只清掉示例卡（不碰真实通知）。
			const postTest = async (body, doneMessage) => {
				setStatus("testing");
				try {
					const response = await fetch(ROUTE + "/test", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					const result = await response.json();
					if (result && result.ok) setStatus(doneMessage);
					else {
						setStatus("error");
						setError("测试请求失败");
					}
				} catch (testError) {
					setStatus("error");
					setError("测试请求失败：" + String((testError && testError.message) || testError));
				}
			};
			const testPopup = () => void postTest({ count: 3 }, "tested");
			const clearTest = () => void postTest({ clear: true }, "cleared");

			// 与 fans 系列插件一致：有改动才亮「保存配置」，无改动置灰。
			const dirty = saved !== null && stableStringify(config) !== stableStringify(saved);

			return h(
				"div",
				{ style: styles.page },
				h(
					"p",
					{ style: styles.intro },
					"通知由宿主进程产生，不依赖页面是否打开；卡片常驻在 DSH 窗口右下角（输入框上方），只有点 ✕、点「全部清除」或进入对应会话才会消失。改位置或透明度后想立刻看效果，点下面的「测试弹窗」。设置保存后立即生效（会重启一次弹窗进程）。",
				),

				h("p", { style: styles.groupTitle }, "总开关"),
				row("启用通知弹窗", "关闭后不再产生任何卡片（已显示的也会清空）", checkbox(config.enabled, (value) => update({ enabled: value }))),
				row(
					"子代理会话也提醒",
					"子代理是某个主会话里的一步，默认不提醒以免刷屏",
					checkbox(config.includeSubagents, (value) => update({ includeSubagents: value })),
				),

				h("p", { style: styles.groupTitle }, "提醒哪几类"),
				row("回合完成", "Agent 把这一轮回复跑完时提醒", checkbox(config.kinds.done, (value) => updateKind("done", value))),
				row("待审批 / 计划确认", "工具调用等你批准，或计划等你确认", checkbox(config.kinds.approval, (value) => updateKind("approval", value))),
				row("等待回答", "Agent 用 ask_user_question 等你选", checkbox(config.kinds.question, (value) => updateKind("question", value))),
				row("出错 / 被中断", "本轮报错、被拦截或被中断", checkbox(config.kinds.errors, (value) => updateKind("errors", value))),

				h("p", { style: styles.groupTitle }, "弹窗位置"),
				row(
					"底部避让高度",
					"距 DSH 窗口底部的距离（0 – 400），需大于输入框高度，避开发送按钮区",
					h("input", {
						style: styles.number,
						type: "number",
						min: 0,
						max: 400,
						step: 10,
						value: config.window.bottomOffset,
						onChange: (event) => updateWindow("bottomOffset", Number(event.target.value)),
					}),
				),
				row(
					"右侧偏移",
					"距 DSH 窗口右缘的距离（0 – 400），0 就是贴住右缘",
					h("input", {
						style: styles.number,
						type: "number",
						min: 0,
						max: 400,
						step: 10,
						value: config.window.rightOffset,
						onChange: (event) => updateWindow("rightOffset", Number(event.target.value)),
					}),
				),

				h("p", { style: styles.groupTitle }, "弹窗外观"),
				row(
					"卡片背景不透明度",
					"20% – 100%；只调背景底色，文字保持清晰。鼠标悬停时底色加深便于阅读",
					h("input", {
						style: styles.number,
						type: "number",
						min: 20,
						max: 100,
						step: 5,
						value: config.window.cardOpacity,
						onChange: (event) => updateWindow("cardOpacity", Number(event.target.value)),
					}),
				),
				row(
					"配色",
					"auto 跟随 Windows 浅色/深色",
					h(
						"select",
						{ style: styles.select, value: config.window.theme, onChange: (event) => updateWindow("theme", event.target.value) },
						h("option", { value: "auto" }, "跟随系统"),
						h("option", { value: "light" }, "浅色"),
						h("option", { value: "dark" }, "深色"),
					),
				),
				row(
					"显示在哪块屏",
					"dsh：跟随 DSH 窗口所在屏；primary：固定主屏",
					h(
						"select",
						{ style: styles.select, value: config.window.screen, onChange: (event) => updateWindow("screen", event.target.value) },
						h("option", { value: "dsh" }, "跟随 DSH 窗口"),
						h("option", { value: "primary" }, "主屏"),
					),
				),
				row(
					"卡片宽度",
					"260 – 620 像素",
					h("input", {
						style: styles.number,
						type: "number",
						min: 260,
						max: 620,
						step: 10,
						value: config.window.width,
						onChange: (event) => updateWindow("width", Number(event.target.value)),
					}),
				),
				row(
					"最多同时显示",
					"1 – 20 条，超出的折叠成「还有 N 条」",
					h("input", {
						style: styles.number,
						type: "number",
						min: 1,
						max: 20,
						value: config.window.maxVisible,
						onChange: (event) => updateWindow("maxVisible", Number(event.target.value)),
					}),
				),

				h("p", { style: styles.groupTitle }, "测试"),
				h(
					"div",
					{ style: styles.footer },
					h("button", { type: "button", style: styles.footerButton, onClick: testPopup }, "测试弹窗"),
					h("button", { type: "button", style: styles.footerButton, onClick: clearTest }, "清除测试卡片"),
					h("span", { style: styles.formHintText }, "发 3 张示例卡即时预览位置与透明度；清除只删示例卡，不影响真实通知"),
				),

				h("p", { style: styles.groupTitle }, "保存"),
				h(
					"div",
					{ style: styles.footer },
					h(
						"button",
						{
							type: "button",
							disabled: !dirty || status === "saving",
							style: !dirty
								? Object.assign({}, styles.footerButton, { opacity: 0.45, cursor: "default" })
								: status === "saving"
									? Object.assign({}, styles.primaryButton, { opacity: 0.5, cursor: "default" })
									: styles.primaryButton,
							onClick: save,
						},
						status === "saving" ? "保存中…" : "保存配置",
					),
					h("button", { type: "button", style: styles.footerButton, onClick: reset }, "恢复默认"),
					h(
						"span",
						{ style: styles.formHintText },
						status === "saved" ? "已保存并生效"
						: status === "tested" ? "已发送测试卡片"
						: status === "cleared" ? "已清除测试卡片"
						: status === "error" ? error
						: dirty ? "有未保存的修改"
						: "与已保存的设置一致",
					),
				),
				h("p", { style: styles.formHintText }, "「恢复默认」只把表单改回默认值，仍需点「保存配置」才会生效。"),
			);
		}

		// ── module ────────────────────────────────────────────────────────

		function apply(ctx) {
			ctx.effect(
				() => {
					previous = new Map(snapshotOf(ctx));
					const muted = silenceNotifyMe();
					fetch(ROUTE + "/client-event", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: "notify-me-muted", detail: muted }),
					}).catch(() => {});
					const timer = setInterval(() => {
						void tick(ctx);
					}, POLL_MS);
					// A hidden window throttles timers to once a minute; being raised
					// by the notification window is exactly when the command must land.
					const wake = () => {
						void tick(ctx);
					};
					window.addEventListener("focus", wake);
					document.addEventListener("visibilitychange", wake);
					void tick(ctx);
					return () => {
						clearInterval(timer);
						window.removeEventListener("focus", wake);
						document.removeEventListener("visibilitychange", wake);
					};
				},
				"dsh-notify-center: session bridge",
			);

			const slots = service(ctx, "slots");
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
			ctx.effect(
				() => slots.inject(CONFIG_SLOT, () => slots.register({ name: CONFIG_SLOT, key: CONFIG_KEY }, ConfigPage)),
				"dsh-notify-center: plugin settings page",
			);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
