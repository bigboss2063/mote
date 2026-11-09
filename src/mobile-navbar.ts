import { Platform } from "obsidian";

/**
 * 贴底控件和导航顶边之间留出的空隙。
 * 手机底部导航是悬浮条，8px 会让加号、生成洞察和正文操作贴着菜单。
 */
export const MOBILE_NAVBAR_GAP = 24;

export interface NavbarBox {
  top: number;
  height: number;
  width: number;
}

/**
 * 把贴底 UI 抬到会挡住它的导航上方。
 * `targetBottom` 是被挡住的那一块的底边（和 `navbar.top` 同一坐标系）。
 * 底边刚好贴在导航顶上时也要留出 `gap`，否则按钮会贴着菜单。
 * 底边已经高出导航至少 `gap`、或导航不可测时返回 0，避免再空出一条。
 */
export function navbarClearancePx(
  targetBottom: number,
  navbar: NavbarBox | null,
  gap = MOBILE_NAVBAR_GAP
): number {
  if (!navbar || navbar.height <= 0 || navbar.width <= 0) return 0;
  const overlap = targetBottom - navbar.top;
  if (overlap <= -gap) return 0;
  return Math.round(overlap + gap);
}

/** `ready: false` 表示导航还没挂上或还没布局，调用方应保留样式表里的保守高度。 */
function readNavbar(doc: Document): { box: NavbarBox | null; ready: boolean } {
  const navbar = doc.querySelector(".mobile-navbar");
  if (!(navbar instanceof HTMLElement)) return { box: null, ready: false };
  const view = doc.defaultView;
  if (!view) return { box: null, ready: false };
  const style = view.getComputedStyle(navbar);
  if (style.display === "none" || style.visibility === "hidden") {
    return { box: null, ready: true };
  }
  const rect = navbar.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { box: null, ready: false };
  return {
    box: { top: rect.top, height: rect.height, width: rect.width },
    ready: true,
  };
}

/**
 * 把导航避让写到视图根上。
 * `--mote-mobile-navbar-clearance` 给文档流里的贴底内容（相对视图底边）。
 * `--mote-mobile-navbar-fixed-clearance` 给 `position: fixed` 的加号和输入卡片
 * （相对视口底边）。视图如果已经停在导航上方，两者不一样：加号仍要从视口底抬过整条导航。
 * 导航收起或移出视口后数值回到 0。桌面端不改，沿用样式表里的 0。
 */
export function bindMobileNavbarClearance(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view || !Platform.isMobile) return () => {};

  let last = "";
  let followUp = 0;
  const navbarObserved = new WeakSet<HTMLElement>();
  let resizeObserver: ResizeObserver | null = null;

  const publish = (): void => {
    const navbar = doc.querySelector(".mobile-navbar");
    if (navbar instanceof HTMLElement && !navbarObserved.has(navbar)) {
      navbarObserved.add(navbar);
      resizeObserver?.observe(navbar);
      navbar.addEventListener("transitionend", publish);
    }
    // 导航还没挂上、或还没布局时，保留样式表里的保守高度。
    const reading = readNavbar(doc);
    if (!reading.ready) return;
    // 边框盒含 padding，重复测量不会越加越大。
    // 视图底边已经在导航上方时，文档流只补空隙；fixed 按钮仍按视口底边计算。
    const viewport = view.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : view.innerHeight;
    const inFlow = navbarClearancePx(root.getBoundingClientRect().bottom, reading.box);
    const fixed = navbarClearancePx(viewportBottom, reading.box);
    const next = `${inFlow}/${fixed}`;
    if (next === last) return;
    last = next;
    root.setCssProps({
      "--mote-mobile-navbar-clearance": `${inFlow}px`,
      "--mote-mobile-navbar-fixed-clearance": `${fixed}px`,
    });
  };

  resizeObserver = new view.ResizeObserver(() => {
    publish();
  });

  const schedule = (): void => {
    publish();
    view.clearTimeout(followUp);
    // 导航用 transform 收起时，尺寸不变，ResizeObserver 不会响；动画结束后再量一次。
    followUp = view.setTimeout(publish, 320);
  };

  schedule();
  const onBodyClass = (): void => {
    schedule();
  };
  const bodyObserver = new view.MutationObserver(onBodyClass);
  bodyObserver.observe(doc.body, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
  });
  view.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("resize", schedule);

  return () => {
    view.clearTimeout(followUp);
    resizeObserver?.disconnect();
    bodyObserver.disconnect();
    view.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("resize", schedule);
    const navbar = doc.querySelector(".mobile-navbar");
    if (navbar instanceof HTMLElement) {
      navbar.removeEventListener("transitionend", publish);
    }
  };
}
