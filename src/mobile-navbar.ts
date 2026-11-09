import { Platform } from "obsidian";

/**
 * 贴底控件和遮挡物顶边之间的空隙。这是间距，不是某台设备的导航高度。
 * 导航有多高、键盘有多高，都靠测量，不写死。
 */
export const MOBILE_NAVBAR_GAP = 24;

/**
 * 视觉视口比布局视口矮过这么多，才当成键盘（或其它盖住底部的系统 UI）。
 * 小幅抖动不算，避免把浏览器工具条的晃动当成遮挡。
 */
const KEYBOARD_COVER_THRESHOLD = 48;

export interface NavbarBox {
  top: number;
  height: number;
  width: number;
}

/**
 * 把 `targetBottom` 抬到所有遮挡顶边之上，并留出 `gap`。
 * 遮挡顶边已经比目标底边高出至少 `gap`，或者根本没有遮挡时，返回 0。
 * 调用方自己决定 `targetBottom` 是哪一条边：视图内容的底边，还是视口的底边。
 */
export function clearancePx(
  targetBottom: number,
  coverTops: readonly number[],
  gap = MOBILE_NAVBAR_GAP
): number {
  let edge = Infinity;
  for (const top of coverTops) {
    if (!Number.isFinite(top)) continue;
    // 这条边在目标下方，够不着，忽略。
    if (top >= targetBottom + gap) continue;
    if (top < edge) edge = top;
  }
  if (edge === Infinity) return 0;
  const overlap = targetBottom - edge;
  if (overlap <= -gap) return 0;
  return Math.round(overlap + gap);
}

/**
 * 只考虑底部导航的便捷封装。编辑卡片、浮层定位不要直接用它代替全部遮挡。
 */
export function navbarClearancePx(
  targetBottom: number,
  navbar: NavbarBox | null,
  gap = MOBILE_NAVBAR_GAP
): number {
  if (!navbar || navbar.height <= 0 || navbar.width <= 0) return 0;
  return clearancePx(targetBottom, [navbar.top], gap);
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

/** 导航顶边，加上键盘（视觉视口明显短于布局视口时）的顶边。 */
function coverTops(view: Window, navbar: NavbarBox | null): number[] {
  const tops: number[] = [];
  if (navbar && navbar.height > 0 && navbar.width > 0) tops.push(navbar.top);
  const viewport = view.visualViewport;
  if (viewport) {
    const visualBottom = viewport.offsetTop + viewport.height;
    if (view.innerHeight - visualBottom > KEYBOARD_COVER_THRESHOLD) {
      tops.push(visualBottom);
    }
  }
  return tops;
}

/**
 * 挂到视图根上，按真实遮挡写两个变量，用途不同：
 *
 * - `--mote-mobile-navbar-clearance`：视图内部的文档流。
 *   相对视图底边。列表、洞察页、统计、编辑卡片都走这个，用 padding 把内容盒抬上去。
 * - `--mote-mobile-navbar-fixed-clearance`：挂在 document 上的视口浮层。
 *   相对布局视口底边。弹窗、灯箱、联想菜单用它，不要拿去定位视图里的编辑框。
 *
 * 导航收起、键盘盖住、或视图还没布局时，数值跟着变；没有遮挡时回到 0。
 * 桌面端不改。
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
    const reading = readNavbar(doc);
    if (!reading.ready) return;
    const rootRect = root.getBoundingClientRect();
    // 隐藏的标签页量出来是 0，不能把正在显示的视图的避让清掉。
    if (rootRect.width === 0 && rootRect.height === 0) return;
    const tops = coverTops(view, reading.box);
    const inFlow = clearancePx(rootRect.bottom, tops);
    const fixed = clearancePx(view.innerHeight, tops);
    const next = `${inFlow}/${fixed}`;
    if (next === last) return;
    last = next;
    root.setCssProps({ "--mote-mobile-navbar-clearance": `${inFlow}px` });
    doc.documentElement.setCssProps({
      "--mote-mobile-navbar-fixed-clearance": `${fixed}px`,
    });
  };

  resizeObserver = new view.ResizeObserver(() => {
    publish();
  });

  const schedule = (): void => {
    publish();
    view.clearTimeout(followUp);
    followUp = view.setTimeout(publish, 320);
  };

  schedule();
  const bodyObserver = new view.MutationObserver(schedule);
  bodyObserver.observe(doc.body, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
  });
  view.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("resize", schedule);
  view.visualViewport?.addEventListener("scroll", schedule);

  return () => {
    view.clearTimeout(followUp);
    resizeObserver?.disconnect();
    bodyObserver.disconnect();
    view.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("resize", schedule);
    view.visualViewport?.removeEventListener("scroll", schedule);
    const navbar = doc.querySelector(".mobile-navbar");
    if (navbar instanceof HTMLElement) {
      navbar.removeEventListener("transitionend", publish);
    }
  };
}

/** 视口浮层可用的区域：布局视口减去底部遮挡。编辑框不该用这个来定自己的高度。 */
export function visibleViewport(doc: Document): { width: number; height: number } {
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  const raw = view?.getComputedStyle
    ? view.getComputedStyle(doc.documentElement)
        .getPropertyValue("--mote-mobile-navbar-fixed-clearance")
    : "";
  const inset = parseFloat(raw);
  const cut = Number.isFinite(inset) && inset > 0 ? inset : 0;
  return { width, height: Math.max(0, height - cut) };
}
