// ================= 光标定位 =================
// 联想浮层要贴在"光标"下方，而不是贴在整个 textarea 下面 ——
// 输入框很高时两者能差几百像素。做法是拿一个隐藏镜像 div 复刻 textarea 的排版，
// 把光标前的文本塞进去，再用零宽标记量出光标坐标。

export interface CaretAnchor {
  /** 视口坐标：光标左边缘 */
  left: number;
  /** 视口坐标：光标所在行的上边缘 */
  top: number;
  /** 行高 */
  height: number;
}

export interface PopupPlacement {
  left: number;
  top: number;
}

/** 镜像元素必须复刻的排版样式（用 kebab-case，直接喂 setProperty） */
const MIRROR_PROPS = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "tab-size",
  "direction",
] as const;

export function caretAnchor(textarea: HTMLTextAreaElement): CaretAnchor {
  const rect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;

  const mirror = activeDocument.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.boxSizing = "content-box";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  // 内容宽度要和 textarea 的可排版宽度一致，否则换行位置会差
  mirror.style.width = `${Math.max(0, textarea.clientWidth - paddingLeft - paddingRight)}px`;
  for (const prop of MIRROR_PROPS) {
    const value = style.getPropertyValue(prop);
    if (value) mirror.style.setProperty(prop, value);
  }
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart ?? 0);
  const marker = activeDocument.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  activeDocument.body.appendChild(mirror);

  let left = rect.left + paddingLeft;
  let top = rect.bottom - 20;
  let height = 20;
  try {
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    left = rect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;
    top = rect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;
    if (markerRect.height > 0) height = markerRect.height;
  } catch {
    // 量不出来就退回输入框左下角附近，至少不会飞到屏幕外
  } finally {
    mirror.remove();
  }

  // 光标滚出可视区时夹回输入框内
  const minTop = rect.top;
  const maxTop = Math.max(minTop, rect.bottom - height);
  return {
    left: Math.max(rect.left, Math.min(left, rect.right)),
    top: Math.max(minTop, Math.min(top, maxTop)),
    height,
  };
}

/** 光标下方放不下就翻到光标上方；左右夹进视口。 */
export function placePopup(
  anchor: CaretAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8
): PopupPlacement {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(anchor.left, margin), maxLeft);
  // 4px 是浮层和光标行之间的呼吸间距
  let top = anchor.top + anchor.height + 4;
  if (top + size.height > viewport.height - margin) {
    top = Math.max(margin, anchor.top - size.height - 4);
  }
  return { left: Math.round(left), top: Math.round(top) };
}
