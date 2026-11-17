// dsh-notify-center — always-on-top notification stack for DSH (Windows).
//
// A frameless, no-activate, topmost window pinned to the bottom-right corner of
// the monitor that hosts the DSH window. It polls the host plugin's /state route
// and renders one card per pending notification, oldest on top, newest next to
// the corner. Cards never time out: they leave only when the user presses the
// card's X, presses 全部清除, or opens the session (by clicking the card, or by
// opening that session in DSH itself — the browser half reports that back).
//
// Written for the in-box C# 5 compiler (csc.exe 4.x): no interpolation, no
// null-conditional operators, no expression-bodied members.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32;

namespace DshNotifyCenter
{
    // ───────────────────────────── options ─────────────────────────────

    internal sealed class Options
    {
        public string StateUrl = string.Empty;
        public string ActionUrl = string.Empty;
        public string Token = string.Empty;
        public string Theme = "auto";
        public string Screen = "dsh";
        public string LogFile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dsh-notify-center-window.log");
        public double Width = 360;
        public int MaxVisible = 6;
        // Anchor is fixed to the bottom-right of the DSH window: stacked upward
        // from above the composer area, inset from the right edge. Both offsets
        // are configurable; there is no other anchor by design.
        public string Anchor = "bottom";
        public double BottomOffset = 100;
        public double RightOffset = 8;
        public double CardOpacity = 100;

        public static Options Parse(string[] argv)
        {
            Options o = new Options();
            for (int i = 0; i + 1 < argv.Length; i += 2)
            {
                string key = argv[i];
                string value = argv[i + 1];
                if (key == "--state-url") o.StateUrl = value;
                else if (key == "--action-url") o.ActionUrl = value;
                else if (key == "--token") o.Token = value;
                else if (key == "--theme") o.Theme = value;
                else if (key == "--screen") o.Screen = value;
                else if (key == "--log") o.LogFile = value;
                else if (key == "--anchor") o.Anchor = "bottom"; // kept for argv compatibility; ignored
                else if (key == "--bottom-offset")
                {
                    double v;
                    if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) o.BottomOffset = Math.Min(400, Math.Max(0, v));
                }
                else if (key == "--right-offset")
                {
                    double v;
                    if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) o.RightOffset = Math.Min(400, Math.Max(0, v));
                }
                else if (key == "--card-opacity")
                {
                    double v;
                    if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) o.CardOpacity = Math.Min(100, Math.Max(20, v));
                }
                else if (key == "--top-offset" || key == "--top-shift")
                {
                    // Obsolete arguments from older hosts: accepted and ignored so a
                    // mixed-generation install never fails to parse.
                }
                else if (key == "--width")
                {
                    double w;
                    if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out w) && w >= 260 && w <= 620) o.Width = w;
                }
                else if (key == "--max-visible")
                {
                    int n;
                    if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= 20) o.MaxVisible = n;
                }
            }
            if (o.StateUrl.Length == 0 || o.ActionUrl.Length == 0)
            {
                throw new ArgumentException("both --state-url and --action-url are required");
            }
            return o;
        }
    }

    // ───────────────────────────── wire types ─────────────────────────────

    internal sealed class ItemDto
    {
        public string id { get; set; }
        public string kind { get; set; }
        public string sessionId { get; set; }
        public string title { get; set; }
        public string workspace { get; set; }
        public string detail { get; set; }
        public double time { get; set; }
    }

    internal sealed class StateDto
    {
        public long version { get; set; }
        public string theme { get; set; }
        public string sig { get; set; }
        public List<ItemDto> items { get; set; }
    }

    // ───────────────────────────── palette ─────────────────────────────

    internal sealed class Palette
    {
        public Brush CardBg;
        public Brush CardHover;
        public Brush CardBorder;
        public Brush Title;
        public Brush Meta;
        public Brush CloseHover;
        public Brush Header;
        public Brush HeaderBorder;
        public Brush HeaderBtnBg;
        public Brush Accent;
        // 卡片背景的基色（不含 alpha）；实际刷子按配置的不透明度百分比补 alpha，
        // 文字与描边保持完全不透明。
        public Color CardBgBase;

        public static Palette Light()
        {
            Palette p = new Palette();
            p.CardBgBase = Color.FromRgb(0xFF, 0xFF, 0xFF);
            p.CardBg = Frozen("#FFFFFFFF");
            p.CardHover = Frozen("#FFF4F6F9");
            p.CardBorder = Frozen("#1A0F172A");
            p.Title = Frozen("#FF111827");
            p.Meta = Frozen("#FF6B7280");
            p.CloseHover = Frozen("#14000000");
            p.Header = Frozen("#CC6B7280");
            p.HeaderBorder = Frozen("#33000000");
            p.HeaderBtnBg = Frozen("#14000000");
            p.Accent = Frozen("#FF2F6BFF");
            return p;
        }

        public static Palette Dark()
        {
            Palette p = new Palette();
            p.CardBgBase = Color.FromRgb(0x1F, 0x24, 0x30);
            p.CardBg = Frozen("#FA1F2430");
            p.CardHover = Frozen("#FF2A3142");
            p.CardBorder = Frozen("#33FFFFFF");
            p.Title = Frozen("#FFF9FAFB");
            p.Meta = Frozen("#FF9CA3AF");
            p.CloseHover = Frozen("#22FFFFFF");
            p.Header = Frozen("#CC9CA3AF");
            p.HeaderBorder = Frozen("#4DFFFFFF");
            p.HeaderBtnBg = Frozen("#1AFFFFFF");
            p.Accent = Frozen("#FF5B8CFF");
            return p;
        }

        private static Brush Frozen(string hex)
        {
            SolidColorBrush b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            b.Freeze();
            return b;
        }
    }

    // ───────────────────────────── win32 ─────────────────────────────

    internal static class Native
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int SW_RESTORE = 9;
        public const uint MONITOR_DEFAULTTONEAREST = 2;
        public const byte VK_MENU = 0x12;
        public const uint KEYEVENTF_KEYUP = 2;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
        [DllImport("user32.dll")]
        public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        public delegate bool EnumWindowsProc(IntPtr handle, IntPtr param);

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_NOOWNERZORDER = 0x0200;
        public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    }

    // ───────────────────────────── program ─────────────────────────────

    internal static class Program
    {
        private const string WindowTitle = "DSH 通知中心";

        [STAThread]
        private static void Main(string[] argv)
        {
            // Per-monitor DPI, before WPF creates anything: without it the card
            // is rendered at 96 dpi on a scaled second screen and lands off the
            // bottom edge, because WPF coordinates and Win32 rectangles disagree.
            try
            {
                Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            catch (Exception)
            {
                // Windows 7/8: the manifest declaration is the only option there.
            }

            Options options;
            try
            {
                options = Options.Parse(argv);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, WindowTitle, MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            // One window per machine: a stale instance from a previous host
            // generation would otherwise stack a second copy of every card.
            bool created;
            using (Mutex mutex = new Mutex(true, "dsh-notify-center-window", out created))
            {
                if (!created) return;

                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                NotifyWindow window = new NotifyWindow(options);
                app.Run();
                GC.KeepAlive(window);
            }
        }
    }

    // ───────────────────────────── window ─────────────────────────────

    internal sealed class NotifyWindow : Window
    {
        private readonly Options _options;
        private readonly HttpClient _http;
        private readonly DispatcherTimer _timer;
        private readonly StackPanel _stack;
        private readonly StackPanel _cards;
        private readonly Border _header;
        private Border _clearButton;
        private TextBlock _clearText;
        private readonly TextBlock _headerCount;
        private readonly Dictionary<string, Border> _cardMap;
        private Palette _palette;
        private long _version = long.MinValue;
        private string _sig = string.Empty;
        private bool _polling;
        private int _failures;

        public NotifyWindow(Options options)
        {
            _options = options;
            _cardMap = new Dictionary<string, Border>();

            Title = "DSH 通知中心";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            WindowStartupLocation = WindowStartupLocation.Manual;
            SizeToContent = SizeToContent.Height;
            Width = options.Width + 32;
            Visibility = Visibility.Hidden;
            FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");
            SnapsToDevicePixels = true;
            UseLayoutRounding = true;

            _palette = Palette.Light();

            Border shell = new Border();
            shell.Padding = new Thickness(16, 12, 16, 16);
            shell.Background = Brushes.Transparent;

            _stack = new StackPanel();
            shell.Child = _stack;
            Content = shell;

            _header = new Border();
            _header.CornerRadius = new CornerRadius(6);
            _header.Padding = new Thickness(4, 2, 2, 2);
            _header.Background = Brushes.Transparent;
            _header.Visibility = Visibility.Collapsed;

            Grid headerGrid = new Grid();
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition());
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            _headerCount = new TextBlock();
            _headerCount.FontSize = 12.5;
            _headerCount.FontWeight = FontWeights.SemiBold;
            _headerCount.Foreground = _palette.Title;
            _headerCount.Opacity = 0.82;
            _headerCount.VerticalAlignment = VerticalAlignment.Center;

            // 「全部清除」：主色文字按钮（方案 5）——无框无底、蓝色半粗字、
            // 悬停出现下划线；内边距保证命中区 ≥60×24。
            Border clear = new Border();
            clear.CornerRadius = new CornerRadius(6);
            clear.Padding = new Thickness(12, 3, 12, 5);
            clear.Background = Brushes.Transparent;
            clear.Cursor = Cursors.Hand;

            TextBlock clearText = new TextBlock();
            clearText.Text = "全部清除";
            clearText.FontSize = 12;
            clearText.FontWeight = FontWeights.SemiBold;
            clearText.Foreground = _palette.Accent;
            clearText.HorizontalAlignment = HorizontalAlignment.Center;
            clearText.VerticalAlignment = VerticalAlignment.Center;
            clear.Child = clearText;

            clear.MouseEnter += delegate { clearText.TextDecorations = System.Windows.TextDecorations.Underline; };
            clear.MouseLeave += delegate { clearText.TextDecorations = null; };
            clear.MouseLeftButtonUp += delegate(object sender, MouseButtonEventArgs e)
            {
                e.Handled = true;
                ClearAll();
            };

            Grid.SetColumn(_headerCount, 0);
            Grid.SetColumn(clear, 1);
            headerGrid.Children.Add(_headerCount);
            headerGrid.Children.Add(clear);
            _header.Child = headerGrid;
            _clearButton = clear;
            _clearText = clearText;

            _cards = new StackPanel();
            _stack.Children.Add(_header);
            _stack.Children.Add(_cards);

            SourceInitialized += OnSourceInitialized;
            SizeChanged += delegate { Reposition(); };
            DpiChanged += delegate { Dispatcher.BeginInvoke(new Action(Reposition), DispatcherPriority.Loaded); };

            _http = new HttpClient();
            _http.Timeout = TimeSpan.FromSeconds(4);

            _timer = new DispatcherTimer();
            _timer.Interval = TimeSpan.FromMilliseconds(700);
            _timer.Tick += delegate { Poll(); };
            _timer.Start();

            Log("start pid=" + Process.GetCurrentProcess().Id + " state=" + options.StateUrl + " screen=" + options.Screen);

            // First paint must not depend on a mouse event.
            Dispatcher.BeginInvoke(new Action(Poll), DispatcherPriority.Background);
        }

        // Diagnostic trail for the window process. It is small and always on:
        // "窗口没弹出来" is otherwise impossible to diagnose from the outside.
        private bool _logStarted;

        private void Log(string message)
        {
            if (string.IsNullOrEmpty(_options.LogFile)) return;
            try
            {
                string line = DateTime.Now.ToString("MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine;
                if (!_logStarted)
                {
                    _logStarted = true;
                    System.IO.File.WriteAllText(_options.LogFile, line);
                    return;
                }
                System.IO.FileInfo info = new System.IO.FileInfo(_options.LogFile);
                if (info.Exists && info.Length > 512 * 1024) System.IO.File.WriteAllText(_options.LogFile, line);
                else System.IO.File.AppendAllText(_options.LogFile, line);
            }
            catch (Exception)
            {
            }
        }

        // The window must never steal focus from whatever the user is typing in.
        private void OnSourceInitialized(object sender, EventArgs e)
        {
            IntPtr handle = new WindowInteropHelper(this).Handle;
            int style = Native.GetWindowLong(handle, Native.GWL_EXSTYLE);
            style = style | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
            Native.SetWindowLong(handle, Native.GWL_EXSTYLE, style);
        }

        // ───────────────────────── transport ─────────────────────────

        private async void Poll()
        {
            if (_polling) return;
            _polling = true;
            try
            {
                string separator = _options.StateUrl.IndexOf('?') >= 0 ? "&" : "?";
                string url = _options.StateUrl + separator + "token=" + Uri.EscapeDataString(_options.Token);
                using (HttpResponseMessage response = await _http.GetAsync(url).ConfigureAwait(true))
                {
                    if ((int)response.StatusCode == 403)
                    {
                        // Our token was rejected: the host plugin reloaded and a
                        // newer window generation owns the route now. Sitting here
                        // polling forever would also block the replacement (the
                        // host keeps one window per machine), so bow out at once.
                        Log("stale token (403) — exiting for the next generation");
                        Application.Current.Shutdown();
                        return;
                    }
                    if ((int)response.StatusCode == 404)
                    {
                        // Route gone: the host is mid-reload. Keep trying; the
                        // route comes back with the new generation.
                        throw new Exception("route not found yet (host reloading)");
                    }
                    response.EnsureSuccessStatusCode();
                    string body = await response.Content.ReadAsStringAsync().ConfigureAwait(true);
                    _failures = 0;
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    serializer.MaxJsonLength = 4 * 1024 * 1024;
                    StateDto state = serializer.Deserialize<StateDto>(body);
                    Apply(state);
                }
            }
            catch (Exception error)
            {
                // A dead host (quit, reload, crash) must not leave a zombie
                // window on screen forever.
                _failures++;
                if (_failures == 1 || _failures % 20 == 0) Log("poll failed (" + _failures + "): " + error.Message);
                if (_failures > 90) Application.Current.Shutdown();
            }
            finally
            {
                _polling = false;
            }
        }

        private async void SendAction(string action, string id)
        {
            Log("action " + action + " id=" + (id ?? string.Empty));
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["action"] = action;
                if (!string.IsNullOrEmpty(id)) payload["id"] = id;
                payload["token"] = _options.Token;
                string json = serializer.Serialize(payload);
                using (StringContent content = new StringContent(json, Encoding.UTF8, "application/json"))
                {
                    await _http.PostAsync(_options.ActionUrl, content).ConfigureAwait(true);
                }
            }
            catch (Exception)
            {
                // The next poll restores whatever really happened.
            }
        }

        // ───────────────────────── state → pixels ─────────────────────────

        private void Apply(StateDto state)
        {
            if (state == null) return;
            ApplyTheme(state.theme);

            // The host sends a fingerprint of the launch arguments. When it
            // changes (保存配置), this window's argv is stale — exit and let the
            // host respawn one with the new anchor/offsets/theme.
            string signature = state.sig ?? string.Empty;
            if (_sig.Length > 0 && signature != _sig)
            {
                Log("config changed (" + signature + ") — exiting for respawn");
                Application.Current.Shutdown();
                return;
            }
            _sig = signature;

            if (state.version == _version) return;
            _version = state.version;
            List<ItemDto> items = state.items == null ? new List<ItemDto>() : state.items;
            Build(items);
        }

        private void ApplyTheme(string theme)
        {
            bool dark;
            if (theme == "dark") dark = true;
            else if (theme == "light") dark = false;
            else dark = !SystemUsesLightTheme();
            _palette = dark ? Palette.Dark() : Palette.Light();
            RefreshBrushes();
        }

        private void RefreshBrushes()
        {
            foreach (KeyValuePair<string, Border> pair in _cardMap)
            {
                Border card = pair.Value;
                card.Background = MakeCardBackground();
                card.BorderBrush = _palette.CardBorder;
                ApplyCardBrushes(card);
            }
            _headerCount.Foreground = _palette.Title;
            if (_clearButton != null)
            {
                _clearButton.Background = Brushes.Transparent;
                if (_clearText != null) _clearText.Foreground = _palette.Accent;
            }
        }

        // 卡片背景刷子：基色按配置的不透明度百分比补 alpha。只透背景，文字、
        // 描边、色条全部保持不透明——这才是「背景色透明度」的本意。
        private Brush MakeCardBackground()
        {
            double percent = Math.Max(20, Math.Min(100, _options.CardOpacity));
            byte alpha = (byte)Math.Round(255 * percent / 100.0);
            Color baseColor = _palette.CardBgBase;
            SolidColorBrush brush = new SolidColorBrush(Color.FromArgb(alpha, baseColor.R, baseColor.G, baseColor.B));
            brush.Freeze();
            return brush;
        }

        private void ApplyCardBrushes(Border card)
        {
            foreach (object child in LogicalTreeHelper.GetChildren(card))
            {
                Grid grid = child as Grid;
                if (grid == null) continue;
                foreach (object cell in grid.Children)
                {
                    StackPanel panel = cell as StackPanel;
                    if (panel == null) continue;
                    for (int i = 0; i < panel.Children.Count; i++)
                    {
                        TextBlock text = panel.Children[i] as TextBlock;
                        if (text == null) continue;
                        text.Foreground = i == 0 ? _palette.Title : _palette.Meta;
                    }
                }
            }
        }

        private void Build(List<ItemDto> items)
        {
            _cards.Children.Clear();
            _cardMap.Clear();

            Log("build items=" + items.Count);
            if (items.Count == 0)
            {
                _header.Visibility = Visibility.Collapsed;
                HideWindow();
                return;
            }

            List<ItemDto> ordered = new List<ItemDto>(items);
            ordered.Sort(delegate(ItemDto a, ItemDto b) { return a.time.CompareTo(b.time); });

            int hidden = 0;
            if (ordered.Count > _options.MaxVisible)
            {
                hidden = ordered.Count - _options.MaxVisible;
                ordered = ordered.GetRange(ordered.Count - _options.MaxVisible, _options.MaxVisible);
            }

            _headerCount.Text = items.Count + " 项待处理";
            _headerCount.Foreground = _palette.Title;
            _header.Visibility = Visibility.Visible;

            // Bottom anchor grows upward: children are oldest → newest, so the
            // newest card sits nearest the corner.
            for (int i = 0; i < ordered.Count; i++)
            {
                Border card = BuildCard(ordered[i]);
                _cards.Children.Add(card);
                _cardMap[ordered[i].id] = card;
                AnimateIn(card, i);
            }

            ShowWindow();
            FoldToAvailableHeight(ordered, ref hidden);

            if (hidden > 0)
            {
                TextBlock more = new TextBlock();
                more.Text = "还有 " + hidden + " 条更早的通知";
                more.FontSize = 11;
                more.Foreground = _palette.Meta;
                more.Margin = new Thickness(4, 0, 0, 6);
                _cards.Children.Insert(0, more);
            }

            ShowWindow();
        }

        // The stack must stay between the bottom offset (composer area) and the
        // title bar at the top. Oldest visible cards fold away first until it fits.
        private void FoldToAvailableHeight(List<ItemDto> ordered, ref int hidden)
        {
            IntPtr dsh = _options.Screen == "primary" ? IntPtr.Zero : FindDshWindow();
            double workHeight;
            if (dsh != IntPtr.Zero)
            {
                Native.RECT win;
                if (!Native.GetWindowRect(dsh, out win)) return;
                workHeight = win.Bottom - win.Top;
            }
            else
            {
                IntPtr monitor = TargetMonitor();
                Native.MONITORINFO info = new Native.MONITORINFO();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
                if (!Native.GetMonitorInfo(monitor, ref info)) return;
                workHeight = info.rcWork.Bottom - info.rcWork.Top;
            }

            double scale = VisualTreeHelper.GetDpi(this).DpiScaleX;
            if (scale <= 0) scale = 1;
            // Title bar plus the window frame around the work surface.
            double reserve = 40;
            double available = Math.Max(120, workHeight / scale - _options.BottomOffset - reserve);

            int guard = 0;
            while (guard++ < 24 && ordered.Count > 0)
            {
                UpdateLayout();
                double stack = _stack.ActualHeight + 28; // shell padding
                if (stack <= available) break;

                ItemDto oldest = ordered[0];
                Border card;
                if (!_cardMap.TryGetValue(oldest.id, out card)) break;
                double cardHeight = card.ActualHeight + card.Margin.Bottom + card.Margin.Top;
                _cards.Children.Remove(card);
                _cardMap.Remove(oldest.id);
                ordered.RemoveAt(0);
                hidden++;
                if (stack - cardHeight <= available && hidden > 0) break;
            }
        }

        private Border BuildCard(ItemDto item)
        {
            Border card = new Border();
            card.CornerRadius = new CornerRadius(10);
            card.Background = MakeCardBackground();
            card.BorderBrush = _palette.CardBorder;
            card.BorderThickness = new Thickness(1);
            card.Margin = new Thickness(0, 0, 0, 8);
            card.Cursor = Cursors.Hand;

            DropShadowEffect shadow = new DropShadowEffect();
            shadow.BlurRadius = 14;
            shadow.ShadowDepth = 2;
            shadow.Direction = 270;
            shadow.Opacity = 0.22;
            shadow.Color = Colors.Black;
            card.Effect = shadow;

            Grid grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(10) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(28) });

            Border accent = new Border();
            accent.CornerRadius = new CornerRadius(2);
            accent.Margin = new Thickness(6, 10, 0, 10);
            accent.Background = KindBrush(item.kind);
            Grid.SetColumn(accent, 0);

            StackPanel text = new StackPanel();
            text.Margin = new Thickness(10, 8, 2, 9);

            TextBlock title = new TextBlock();
            title.Text = string.IsNullOrEmpty(item.title) ? "未命名会话" : item.title;
            title.FontSize = 13;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = _palette.Title;
            title.TextTrimming = TextTrimming.CharacterEllipsis;
            title.TextWrapping = TextWrapping.NoWrap;

            TextBlock meta = new TextBlock();
            meta.Text = Describe(item);
            meta.FontSize = 11.5;
            meta.Foreground = _palette.Meta;
            meta.Margin = new Thickness(0, 3, 0, 0);
            meta.TextTrimming = TextTrimming.CharacterEllipsis;
            meta.TextWrapping = TextWrapping.NoWrap;

            text.Children.Add(title);
            text.Children.Add(meta);
            Grid.SetColumn(text, 1);

            Border close = new Border();
            close.Width = 20;
            close.Height = 20;
            close.CornerRadius = new CornerRadius(10);
            close.Background = Brushes.Transparent;
            close.Margin = new Thickness(0, 8, 8, 0);
            close.VerticalAlignment = VerticalAlignment.Top;
            close.HorizontalAlignment = HorizontalAlignment.Right;
            close.Cursor = Cursors.Hand;

            TextBlock cross = new TextBlock();
            cross.Text = "✕";
            cross.FontSize = 10;
            cross.Foreground = _palette.Meta;
            cross.HorizontalAlignment = HorizontalAlignment.Center;
            cross.VerticalAlignment = VerticalAlignment.Center;
            close.Child = cross;

            string id = item.id;
            close.MouseEnter += delegate { close.Background = _palette.CloseHover; };
            close.MouseLeave += delegate { close.Background = Brushes.Transparent; };
            close.MouseLeftButtonUp += delegate(object sender, MouseButtonEventArgs e)
            {
                e.Handled = true;
                Dismiss(id);
            };
            Grid.SetColumn(close, 2);

            grid.Children.Add(accent);
            grid.Children.Add(text);
            grid.Children.Add(close);
            card.Child = grid;

            // 背景按配置的不透明度渲染（只透底色，文字保持清晰）。
            card.Background = MakeCardBackground();

            // Hover feedback: the whole card is one button, so it has to look
            // like one — the palette differs per theme, hence the deferred read.
            card.MouseEnter += delegate { card.Background = _palette.CardHover; };
            card.MouseLeave += delegate { card.Background = MakeCardBackground(); };
            card.MouseLeftButtonUp += delegate { Open(id); };
            return card;
        }

        private static string Describe(ItemDto item)
        {
            string text = KindLabel(item.kind) + " · " + Ago(item.time);
            if (!string.IsNullOrEmpty(item.workspace)) text += " · " + item.workspace;
            if (!string.IsNullOrEmpty(item.detail)) text += " · " + item.detail;
            return text;
        }

        private static string KindLabel(string kind)
        {
            if (kind == "approval") return "待审批";
            if (kind == "question") return "待回答";
            if (kind == "error") return "出错";
            if (kind == "done") return "已完成";
            return "提醒";
        }

        private static Brush KindBrush(string kind)
        {
            string hex = "#FF94A3B8";
            if (kind == "approval") hex = "#FFF59E0B";
            else if (kind == "question") hex = "#FFEAB308";
            else if (kind == "error") hex = "#FFEF4444";
            else if (kind == "done") hex = "#FF22C55E";
            SolidColorBrush brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            brush.Freeze();
            return brush;
        }

        private static string Ago(double epochMs)
        {
            if (epochMs <= 0) return "";
            double diff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - epochMs;
            if (diff < 0) diff = 0;
            if (diff < 60000) return "刚刚";
            if (diff < 3600000) return ((int)(diff / 60000)) + " 分钟前";
            if (diff < 86400000) return ((int)(diff / 3600000)) + " 小时前";
            return ((int)(diff / 86400000)) + " 天前";
        }

        private void AnimateIn(Border card, int index)
        {
            TranslateTransform shift = new TranslateTransform(24, 0);
            card.RenderTransform = shift;
            card.Opacity = 0;

            Duration duration = new Duration(TimeSpan.FromMilliseconds(190));
            CubicEase ease = new CubicEase();
            ease.EasingMode = EasingMode.EaseOut;

            DoubleAnimation fade = new DoubleAnimation(0, 1, duration);
            fade.EasingFunction = ease;
            DoubleAnimation slide = new DoubleAnimation(24, 0, duration);
            slide.EasingFunction = ease;

            card.BeginAnimation(UIElement.OpacityProperty, fade);
            shift.BeginAnimation(TranslateTransform.XProperty, slide);
        }

        // ───────────────────────── user actions ─────────────────────────

        private void Open(string id)
        {
            RaiseDsh();
            SendAction("open", id);
            RemoveLocal(id);
        }

        private void Dismiss(string id)
        {
            SendAction("dismiss", id);
            RemoveLocal(id);
        }

        private void ClearAll()
        {
            SendAction("clear", null);
            _cardMap.Clear();
            _cards.Children.Clear();
            _header.Visibility = Visibility.Collapsed;
            HideWindow();
        }

        private void RemoveLocal(string id)
        {
            Border card;
            if (id != null && _cardMap.TryGetValue(id, out card))
            {
                _cardMap.Remove(id);
                _cards.Children.Remove(card);
            }
            if (_cards.Children.Count == 0)
            {
                _header.Visibility = Visibility.Collapsed;
                HideWindow();
            }
        }

        // ───────────────────────── placement ─────────────────────────

        private void ShowWindow()
        {
            if (!IsVisible) Show();
            UpdateLayout();
            Reposition();
            Log("show " + Left + "," + Top + " " + ActualWidth + "x" + ActualHeight);
        }

        private void HideWindow()
        {
            if (IsVisible) Hide();
            Log("hide");
        }

        private void Reposition()
        {
            if (!IsVisible) return;
            IntPtr handle = new WindowInteropHelper(this).Handle;
            if (handle == IntPtr.Zero) return;

            Native.RECT current;
            if (!Native.GetWindowRect(handle, out current)) return;
            int width = current.Right - current.Left;
            int height = current.Bottom - current.Top;
            if (width <= 0 || height <= 0) return;

            double scale = VisualTreeHelper.GetDpi(this).DpiScaleX;
            if (scale <= 0) scale = 1;
            int rightInset = (int)Math.Round(_options.RightOffset * scale);

            // Place with Win32 physical pixels and real rectangles: WPF's Left/Top
            // live in a per-monitor DIP space that does not match GetWindowRect on
            // a mixed-DPI desktop. Primary anchor is the DSH window's bottom-right,
            // lifted above the composer area and inset from the right edge.
            IntPtr dsh = _options.Screen == "primary" ? IntPtr.Zero : FindDshWindow();
            Native.RECT win;
            if (dsh != IntPtr.Zero && Native.GetWindowRect(dsh, out win))
            {
                int x = win.Right - width - rightInset;
                int y = win.Bottom - height - (int)Math.Round(_options.BottomOffset * scale);
                Native.SetWindowPos(handle, Native.HWND_TOPMOST, x, y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
                Log("place dsh x=" + x + " y=" + y + " size " + width + "x" + height);
                return;
            }

            // Fallback: no DSH window found — anchor to the chosen monitor.
            IntPtr monitor = TargetMonitor();
            Native.MONITORINFO info = new Native.MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
            if (!Native.GetMonitorInfo(monitor, ref info)) return;
            int fx = info.rcWork.Right - width - rightInset;
            int fy = info.rcWork.Bottom - height - (int)Math.Round(_options.BottomOffset * scale);
            Native.SetWindowPos(handle, Native.HWND_TOPMOST, fx, fy, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
            Log("place monitor x=" + fx + " y=" + fy + " size " + width + "x" + height + " windowDpi=" + Native.GetDpiForWindow(handle) + " wpfScale=" + scale.ToString("0.00", CultureInfo.InvariantCulture));
        }

        private IntPtr TargetMonitor()
        {
            if (_options.Screen != "primary")
            {
                IntPtr dsh = FindDshWindow();
                if (dsh != IntPtr.Zero) return Native.MonitorFromWindow(dsh, Native.MONITOR_DEFAULTTONEAREST);
            }
            Native.POINT origin = new Native.POINT();
            origin.X = 0;
            origin.Y = 0;
            return Native.MonitorFromPoint(origin, Native.MONITOR_DEFAULTTONEAREST);
        }

        private static IntPtr _dshWindow = IntPtr.Zero;
        private static DateTime _dshStamp = DateTime.MinValue;
        private static readonly HashSet<int> DshProcessIds = new HashSet<int>();
        private static IntPtr _bestHandle;
        private static long _bestArea;

        private static bool ConsiderWindow(IntPtr handle, IntPtr param)
        {
            if (!Native.IsWindowVisible(handle)) return true;
            uint pid;
            Native.GetWindowThreadProcessId(handle, out pid);
            if (!DshProcessIds.Contains((int)pid)) return true;
            if (Native.GetWindowTextLength(handle) == 0) return true;
            Native.RECT rect;
            if (!Native.GetWindowRect(handle, out rect)) return true;
            long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
            if (area <= _bestArea) return true;
            _bestArea = area;
            _bestHandle = handle;
            return true;
        }

        // The shell's biggest titled top-level window: MainWindowHandle can point
        // at a helper window, and picking the wrong one puts the cards on the
        // wrong monitor or raises the wrong window.
        private static IntPtr FindDshWindow()
        {
            if (_dshWindow != IntPtr.Zero && (DateTime.UtcNow - _dshStamp).TotalSeconds < 5) return _dshWindow;
            try
            {
                DshProcessIds.Clear();
                Process[] processes = Process.GetProcessesByName("DeepSeek Harness");
                for (int i = 0; i < processes.Length; i++) DshProcessIds.Add(processes[i].Id);
                _bestHandle = IntPtr.Zero;
                _bestArea = 0;
                Native.EnumWindows(ConsiderWindow, IntPtr.Zero);
                _dshWindow = _bestHandle;
                _dshStamp = DateTime.UtcNow;
            }
            catch (Exception)
            {
                // Process enumeration is best-effort: fall back to primary.
            }
            return _dshWindow;
        }

        // Bring the DSH window forward before the browser half switches session.
        // Windows refuses SetForegroundWindow from a background process until the
        // foreground lock is released, hence the Alt tap and the input attach.
        private static void RaiseDsh()
        {
            IntPtr handle = FindDshWindow();
            if (handle == IntPtr.Zero) return;
            if (Native.IsIconic(handle)) Native.ShowWindow(handle, Native.SW_RESTORE);
            Native.SetForegroundWindow(handle);
            if (Native.GetForegroundWindow() == handle) return;

            Native.keybd_event(Native.VK_MENU, 0, 0, UIntPtr.Zero);
            Native.keybd_event(Native.VK_MENU, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            Native.SetForegroundWindow(handle);
            if (Native.GetForegroundWindow() == handle) return;

            uint foreground = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), IntPtr.Zero);
            uint self = Native.GetCurrentThreadId();
            if (foreground != 0 && foreground != self)
            {
                Native.AttachThreadInput(self, foreground, true);
                Native.BringWindowToTop(handle);
                Native.SetForegroundWindow(handle);
                Native.AttachThreadInput(self, foreground, false);
            }
        }

        private static bool SystemUsesLightTheme()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    if (key != null)
                    {
                        object value = key.GetValue("AppsUseLightTheme");
                        if (value is int) return (int)value != 0;
                    }
                }
            }
            catch (Exception)
            {
                // A locked-down hive is not worth failing a notification over.
            }
            return true;
        }
    }
}
