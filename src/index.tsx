import { ComponentProps, useEffect, useState } from "react";

/**
 * Finds the scrollable parent element of a given node.
 * This is important because sticky positioning is relative to the nearest scrollable ancestor.
 *
 * @param node - The element to find the scroll parent for
 * @returns The scrollable parent element, or window if no scrollable parent is found
 */
const getScrollParent = (node: HTMLElement) => {
  let parent: HTMLElement | null = node;

  // Walk up the DOM tree looking for a scrollable parent
  while ((parent = parent.parentElement)) {
    const overflowYVal = getComputedStyle(parent, null).getPropertyValue(
      "overflow-y"
    );

    // If we reach the body, return window as the scroll parent
    if (parent === document.body) return window;

    // Check if this parent has scrollable overflow
    if (
      overflowYVal === "auto" ||
      overflowYVal === "scroll" ||
      overflowYVal === "overlay"
    ) {
      return parent;
    }
  }

  // If no scrollable parent found, use window
  return window;
};

/**
 * Checks if an element is an offset parent (has positioning context).
 * This is used to determine how to calculate positions relative to scroll parents.
 *
 * @param el - The element to check
 * @returns True if the element is an offset parent
 */
const isOffsetElement = (el: HTMLElement): boolean =>
  el.firstChild ? (el.firstChild as HTMLElement).offsetParent === el : true;

/**
 * Calculates the offset distance from a node to its target ancestor.
 * This is used to determine the element's position relative to its scroll parent.
 *
 * @param node - The element to calculate offset for
 * @param target - The target ancestor element
 * @returns The offset distance in pixels
 */
const offsetTill = (node: HTMLElement, target: HTMLElement) => {
  let current = node;
  let offset = 0;

  // If target is not an offsetParent itself, we need to adjust the calculation
  if (!isOffsetElement(target)) {
    offset += node.offsetTop - target.offsetTop;
    target = node.offsetParent as HTMLElement;
    offset += -node.offsetTop;
  }

  // Walk up the DOM tree adding offsetTop values until we reach the target
  do {
    offset += current.offsetTop;
    current = current.offsetParent as HTMLElement;
  } while (current && current !== target);

  return offset;
};

/**
 * Gets the actual parent node, skipping elements with display: contents.
 * Elements with display: contents don't create a box, so we need to find their real parent.
 *
 * @param node - The element to find the parent for
 * @returns The actual parent element, or window if none found
 */
const getParentNode = (node: HTMLElement) => {
  let currentParent = node.parentElement;

  // Skip elements with display: contents as they don't create a box
  while (currentParent) {
    const style = getComputedStyle(currentParent, null);
    if (style.getPropertyValue("display") !== "contents") break;
    currentParent = currentParent.parentElement;
  }

  return currentParent || window;
};

/**
 * Feature detection for sticky positioning support.
 * Checks if the browser supports position: sticky or -webkit-sticky.
 */
let stickyProp: null | string = null;
if (typeof CSS !== "undefined" && CSS.supports) {
  if (CSS.supports("position", "sticky")) stickyProp = "sticky";
  else if (CSS.supports("position", "-webkit-sticky"))
    stickyProp = "-webkit-sticky";
}

/**
 * Feature detection for passive event listeners.
 * Passive listeners improve scroll performance by not blocking the main thread.
 * Inspired by https://github.com/WICG/EventListenerOptions/blob/gh-pages/explainer.md#feature-detection
 */
let passiveArg: false | { passive: true } = false;
try {
  const opts = Object.defineProperty({}, "passive", {
    // eslint-disable-next-line getter-return
    get() {
      passiveArg = { passive: true };
    },
  });
  const emptyHandler = () => {};
  window.addEventListener("testPassive", emptyHandler, opts);
  window.removeEventListener("testPassive", emptyHandler, opts);
} catch (e) {}

/*

prop overview:

scroll parent
=============
- scrollY (onScroll)
- scrollParentHeight (onResize)
- scrollParentOffsetTop (onResize)

parent
======
- naturalTop (onResize)
- parentHeight (onResize)

sticky
======
- nodeHeight (onResize)
- offset (onResize)


Fns
===
reLayout() (also called on init)
onScroll()
*/

type UnsubList = (() => void)[];
type MeasureFn<T extends object> = (opts: {
  top: number;
  left: number;
  height: number;
  width: number;
}) => T;

const getDimensions = <T extends object>(opts: {
  el: HTMLElement | Window;
  onChange: () => void;
  unsubs: UnsubList;
  measure: MeasureFn<T>;
}): T => {
  const { el, onChange, unsubs, measure } = opts;
  if (el === window) {
    const getRect = () => ({
      top: 0,
      left: 0,
      height: window.innerHeight,
      width: window.innerWidth,
    });
    const mResult = measure(getRect());
    const handler = () => {
      Object.assign(mResult, measure(getRect()));
      onChange();
    };
    window.addEventListener("resize", handler, passiveArg);
    unsubs.push(() => window.removeEventListener("resize", handler));
    return mResult;
  } else {
    const mResult = measure((el as HTMLElement).getBoundingClientRect());
    const handler: ResizeObserverCallback = () => {
      // note the e[0].contentRect is different from `getBoundingClientRect`
      Object.assign(
        mResult,
        measure((el as HTMLElement).getBoundingClientRect())
      );
      onChange();
    };
    const ro = new ResizeObserver(handler);
    ro.observe(el as HTMLElement);
    unsubs.push(() => ro.disconnect());
    return mResult;
  }
};

const getVerticalPadding = (node: HTMLElement) => {
  const computedParentStyle = getComputedStyle(node, null);
  const parentPaddingTop = parseInt(
    computedParentStyle.getPropertyValue("padding-top"),
    10
  );
  const parentPaddingBottom = parseInt(
    computedParentStyle.getPropertyValue("padding-bottom"),
    10
  );
  return { top: parentPaddingTop, bottom: parentPaddingBottom };
};

/**
 * Defines the different modes/states a sticky element can be in.
 *
 * - stickyTop: Element is stuck to the top of the viewport
 * - stickyBottom: Element is stuck to the bottom of the viewport
 * - relative: Element is in normal document flow (not sticky)
 * - small: Element is small enough to always be sticky
 */
const enum MODES {
  stickyTop,
  stickyBottom,
  relative,
  small,
}

type StickyMode = null | (typeof MODES)[keyof typeof MODES];

/**
 * Parses the waitUntil string to extract the value and determine if it's a percentage.
 *
 * @param waitUntil - String like "300px", "50%", or "300"
 * @returns Object with parsed value and whether it's a percentage
 */
const parseWaitUntil = (
  waitUntil: string
): { value: number; isPercentage: boolean } => {
  const trimmed = waitUntil.trim();

  // Handle percentage values (e.g., "50%")
  if (trimmed.endsWith("%")) {
    return { value: parseFloat(trimmed.slice(0, -1)), isPercentage: true };
  }

  // Handle pixel values (e.g., "300px")
  if (trimmed.endsWith("px")) {
    return { value: parseFloat(trimmed.slice(0, -2)), isPercentage: false };
  }

  // Default to px if no unit specified (e.g., "300")
  return { value: parseFloat(trimmed), isPercentage: false };
};

/**
 * Determines if the element should wait before becoming sticky based on the waitUntil prop.
 *
 * This function calculates when the element would normally become sticky, then adds
 * an additional delay based on the waitUntil value before allowing sticky behavior.
 * Note: waitUntil only applies when scrolling DOWN. When scrolling UP, the element
 * returns to natural position immediately when it reaches that point.
 *
 * @param waitUntil - The waitUntil string (e.g., "300px", "50%")
 * @param scrollY - Current scroll position
 * @param naturalTop - Natural top position of the element
 * @param nodeHeight - Height of the element
 * @param viewPortHeight - Height of the viewport
 * @param offsetTop - Top offset for sticky positioning
 * @param offsetBottom - Bottom offset for sticky positioning
 * @param bottom - Whether the element should stick to bottom
 * @param isScrollingDown - Whether the user is scrolling down (true) or up (false)
 * @returns True if the element should wait before becoming sticky
 */
const shouldWaitForSticky = (
  waitUntil: string | undefined,
  scrollY: number,
  naturalTop: number,
  nodeHeight: number,
  viewPortHeight: number,
  offsetTop: number,
  offsetBottom: number,
  bottom: boolean,
  isScrollingDown: boolean
): boolean => {
  // If no waitUntil specified, don't wait
  if (!waitUntil) return false;

  // Guard against undefined or invalid values (dimensions not calculated yet)
  if (typeof naturalTop !== "number" || typeof offsetTop !== "number") {
    console.log("Waiting for dimensions to be calculated:", {
      naturalTop,
      offsetTop,
    });
    return true; // Wait until we have proper dimensions
  }

  // Handle the case where offsetTop might be a string (from wrapper component)
  const offsetTopValue = typeof offsetTop === "string" ? 0 : offsetTop;

  // Parse the waitUntil value
  const { value, isPercentage } = parseWaitUntil(waitUntil);

  // Calculate the normal sticky trigger point (when element would normally become sticky)
  // For top sticky: when element's top reaches the top of viewport (minus offsetTop)
  // For bottom sticky: when element's bottom reaches the bottom of viewport (plus offsetBottom)
  const normalStickyTriggerPoint = bottom
    ? naturalTop - viewPortHeight + nodeHeight + offsetBottom
    : naturalTop - offsetTopValue;

  // Only apply waitUntil when scrolling DOWN
  if (isScrollingDown) {
    // Calculate the additional wait distance
    const additionalWaitDistance = isPercentage
      ? (value / 100) * viewPortHeight // Convert percentage to pixels
      : value; // Use pixel value directly

    // The actual sticky trigger point is the normal point plus the additional wait
    const actualStickyTriggerPoint =
      normalStickyTriggerPoint + additionalWaitDistance;

    // We should wait if we haven't scrolled past the actual trigger point yet
    const shouldWait = scrollY < actualStickyTriggerPoint;

    // Debug logging
    console.log("WaitUntil check (scrolling down):", {
      scrollY,
      normalStickyTriggerPoint,
      actualStickyTriggerPoint,
      shouldWait,
      viewPortHeight,
    });

    return shouldWait;
  } else {
    // When scrolling UP, use the normal trigger point (no additional wait)
    const shouldWait = scrollY < normalStickyTriggerPoint;

    // Debug logging
    console.log("WaitUntil check (scrolling up):", {
      scrollY,
      normalStickyTriggerPoint,
      shouldWait,
      viewPortHeight,
    });

    return shouldWait;
  }
};

/**
 * Main setup function that initializes the sticky behavior for an element.
 * This function sets up all the event listeners, calculates dimensions, and manages
 * the sticky state transitions.
 *
 * @param node - The DOM element to make sticky
 * @param unsubs - Array to store cleanup functions
 * @param opts - Configuration options for sticky behavior
 */
const setup = (node: HTMLElement, unsubs: UnsubList, opts: StickyBoxConfig) => {
  // Extract configuration options with defaults
  const { bottom = false, offsetBottom = 0, offsetTop = 0, waitUntil } = opts;

  // Find the scrollable parent (could be window or a scrollable container)
  const scrollPane = getScrollParent(node);

  // Flag to prevent multiple simultaneous layout calculations
  let isScheduled = false;

  /**
   * Schedules a layout recalculation using requestAnimationFrame.
   * This ensures smooth performance by batching layout updates.
   */
  const scheduleOnLayout = () => {
    if (!isScheduled) {
      requestAnimationFrame(() => {
        // Calculate the next sticky mode
        const nextMode = onLayout();

        // If mode changed, update the element
        if (nextMode !== mode) {
          changeMode(nextMode);
        } else if (nextMode === MODES.stickyBottom && !bottom) {
          // Ensure sticky bottom positioning is maintained
          const { height: viewPortHeight } = scrollPaneDims;
          const { height: nodeHeight } = nodeDims;
          node.style.top = `${viewPortHeight - nodeHeight - offsetBottom}px`;
        } else if (nextMode === MODES.relative) {
          // Update relative positioning
          const { height: viewPortHeight, offsetTop: scrollPaneOffset } =
            scrollPaneDims;
          const { height: parentHeight, naturalTop } = parentDims;
          const { height: nodeHeight } = nodeDims;

          // Calculate the relative offset to maintain visual position
          const relativeOffset = Math.max(
            0,
            scrollPaneOffset +
              latestScrollY +
              viewPortHeight -
              (naturalTop + nodeHeight + offsetBottom)
          );

          const shouldWait = shouldWaitForSticky(
            waitUntil,
            latestScrollY,
            naturalTop,
            nodeHeight,
            viewPortHeight,
            offsetTop,
            offsetBottom,
            bottom,
            true // Assume scrolling down for scheduleOnLayout
          );

          if (shouldWait) return;
          if (bottom) {
            // For bottom sticky, calculate bottom position
            // const nextBottom = Math.max(
            //   0,
            //   parentHeight - nodeHeight - relativeOffset
            // );

            // node.style.bottom = `${nextBottom}px`; // original line from react-sticky-box (broken)
            // for some reason "bottom" positioning doesn't do anything but "top" does, so we mimic "bottom" behavior via "top" by using `top: 100% - height - offsetBottom`
            node.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
          } else {
            // For top sticky, set top position
            node.style.top = `${relativeOffset}px`;
          }
        }
        isScheduled = false;
      });
    }
    isScheduled = true;
  };

  // Track the current scroll position
  let latestScrollY =
    scrollPane === window
      ? window.scrollY
      : (scrollPane as HTMLElement).scrollTop;

  /**
   * Determines if the element should switch to sticky bottom mode.
   * This happens when the element would be pushed below the viewport.
   *
   * @param scrollY - Current scroll position
   * @returns True if the element should stick to the bottom
   */
  const isBoxTooLow = (scrollY: number) => {
    const { offsetTop: scrollPaneOffset, height: viewPortHeight } =
      scrollPaneDims;
    const { naturalTop } = parentDims;
    const { height: nodeHeight } = nodeDims;

    // Check if the element would be pushed below the viewport
    if (
      scrollY + scrollPaneOffset + viewPortHeight >=
      naturalTop + nodeHeight + relativeOffset + offsetBottom
    ) {
      return true;
    }
    return false;
  };

  /**
   * Determines the appropriate sticky mode based on current scroll position and element dimensions.
   * This is the core logic that decides when the element should be sticky vs. relative.
   *
   * @returns The sticky mode the element should be in
   */
  const onLayout = (): StickyMode => {
    const { height: viewPortHeight, offsetTop: scrollPaneOffset } =
      scrollPaneDims;
    const { height: nodeHeight } = nodeDims;
    const { naturalTop } = parentDims;

    // Check if we should wait for sticky behavior (waitUntil logic)
    // For onLayout, we assume scrolling down (this will be corrected in onScroll)
    const shouldWait = shouldWaitForSticky(
      waitUntil,
      latestScrollY,
      naturalTop,
      nodeHeight,
      viewPortHeight,
      offsetTop,
      offsetBottom,
      bottom,
      true // Assume scrolling down for initial layout
    );

    // Apply hysteresis to prevent flickering at transition boundaries
    const currentStickyState = !shouldWait;
    if (currentStickyState !== lastStickyState) {
      // Only allow state change if we've moved beyond the buffer zone
      const shouldWaitWithBuffer = shouldWaitForSticky(
        waitUntil,
        Math.max(
          0,
          latestScrollY +
            (currentStickyState ? -HYSTERESIS_BUFFER : HYSTERESIS_BUFFER)
        ),
        naturalTop,
        nodeHeight,
        viewPortHeight,
        offsetTop,
        offsetBottom,
        bottom,
        true // Assume scrolling down for hysteresis check
      );

      // If the buffered check gives a different result, maintain current state
      if (shouldWaitWithBuffer !== shouldWait) {
        return mode; // Keep current mode
      }

      // Update last sticky state
      lastStickyState = currentStickyState;
    }

    // If waiting, stay in relative mode
    if (shouldWait) {
      return MODES.relative;
    }

    // If element is small enough to always fit in viewport, use small mode
    if (nodeHeight + offsetTop + offsetBottom <= viewPortHeight) {
      return MODES.small;
    } else {
      // For larger elements, determine if they should stick to top or bottom
      if (isBoxTooLow(latestScrollY)) {
        return MODES.stickyBottom;
      } else {
        return MODES.relative;
      }
    }
  };

  // Check if the scroll pane is an offset element (has positioning context)
  const scrollPaneIsOffsetEl =
    scrollPane !== window && isOffsetElement(scrollPane as HTMLElement);

  // Track scroll pane dimensions (viewport height and offset)
  const scrollPaneDims = getDimensions({
    el: scrollPane,
    onChange: scheduleOnLayout,
    unsubs,
    measure: ({ height, top }) => ({
      height,
      offsetTop: scrollPaneIsOffsetEl ? top : 0, // Only include offset if scroll pane is positioned
    }),
  });

  // Get the actual parent node (skipping display: contents elements)
  const parentNode = getParentNode(node);

  // Calculate parent padding (excluded from height calculations)
  const parentPaddings =
    parentNode === window
      ? { top: 0, bottom: 0 }
      : getVerticalPadding(parentNode as HTMLElement);

  // Track parent dimensions (height and natural top position)
  const parentDims = getDimensions({
    el: parentNode,
    onChange: scheduleOnLayout,
    unsubs,
    measure: ({ height }) => ({
      // Exclude padding from height calculation
      height: height - parentPaddings.top - parentPaddings.bottom,
      // Calculate the natural top position relative to scroll pane
      naturalTop:
        parentNode === window
          ? 0
          : offsetTill(parentNode as HTMLElement, scrollPane as HTMLElement) +
            parentPaddings.top +
            scrollPaneDims.offsetTop,
    }),
  });

  // Track the sticky element's dimensions
  const nodeDims = getDimensions({
    el: node,
    onChange: scheduleOnLayout,
    unsubs,
    measure: ({ height }) => ({ height }),
  });

  // Track the relative offset when transitioning between sticky modes
  let relativeOffset = 0;

  // Add hysteresis buffer to prevent flickering at transition boundaries
  const HYSTERESIS_BUFFER = 2; // pixels
  let lastStickyState = false; // Track if element was sticky in previous frame

  // Initialize the sticky mode
  let mode = onLayout();

  // Set default top: 0 to provide a starting point for CSS transitions
  // This won't affect positioning when position is static/relative without top
  node.style.top = "0px";

  /**
   * Changes the sticky mode and applies the appropriate CSS styles.
   * This function handles the visual transitions between different sticky states.
   *
   * @param newMode - The new sticky mode to apply
   */
  const changeMode = (newMode: StickyMode) => {
    const prevMode = mode;
    mode = newMode;

    // Reset relative offset when transitioning from relative mode
    if (prevMode === MODES.relative) relativeOffset = -1;

    // Add smooth transition when mode changes
    if (prevMode !== newMode) {
      // Since we always have a top value, we can use a simple transition
      node.style.transition = "top 0.3s ease";
    }

    // Handle small mode (element always fits in viewport)
    if (newMode === MODES.small) {
      node.style.position = stickyProp as string;
      if (bottom) {
        // node.style.bottom = `${offsetBottom}px`; // original line from react-sticky-box (broken)
        // for some reason "bottom" positioning doesn't do anything but "top" does, so we mimic "bottom" behavior via "top" by using `top: 100% - height - offsetBottom`
        node.style.top = `calc(100% - ${nodeDims.height}px - ${offsetBottom}px)`;
      } else {
        node.style.top = `${offsetTop}px`;
      }
      return;
    }

    // Get current dimensions for positioning calculations
    const { height: viewPortHeight, offsetTop: scrollPaneOffset } =
      scrollPaneDims;
    const { height: parentHeight, naturalTop } = parentDims;
    const { height: nodeHeight } = nodeDims;

    // Handle relative mode (element in normal document flow)
    if (newMode === MODES.relative) {
      node.style.position = "relative";
      // Check if we've scrolled back to the natural position
      // For top sticky: when scroll position is at or before the natural sticky trigger point
      // For bottom sticky: when scroll position is at or after the natural sticky trigger point
      const isAtNaturalPosition =
        latestScrollY === 0 ||
        (bottom
          ? latestScrollY >=
            naturalTop - viewPortHeight + nodeHeight + offsetBottom
          : latestScrollY <= naturalTop - offsetTop);

      if (isAtNaturalPosition) {
        console.log("ABOVE NATURAL POSITION");
        // Return to natural position - set top to 0 (won't affect positioning when position is relative)
        node.style.top = "0px";
        node.style.bottom = "";
        relativeOffset = 0;
      } else {
        console.log("BELOW NATURAL POSITION");
        // Calculate the relative offset to maintain visual position
        relativeOffset =
          prevMode === MODES.stickyTop
            ? Math.max(
                0,
                scrollPaneOffset + latestScrollY - naturalTop + offsetTop
              )
            : Math.max(
                0,
                scrollPaneOffset +
                  latestScrollY +
                  viewPortHeight -
                  (naturalTop + nodeHeight + offsetBottom)
              );

        // Apply positioning based on bottom vs top sticky
        if (bottom) {
          // console.log({
          //   latestScrollY,
          //   scrollPaneOffset,
          //   parentHeight,
          //   nodeHeight,
          //   offsetBottom,
          //   viewPortHeight,
          //   relativeOffset,
          // });
          // const nextBottom = Math.max(
          //   0,
          //   parentHeight - nodeHeight - relativeOffset
          // );
          // node.style.bottom = `${nextBottom}px`;
          node.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          node.style.top = `${relativeOffset}px`;
        }
      }
    } else {
      // Handle sticky modes (stickyTop or stickyBottom)
      node.style.position = stickyProp as string;

      if (newMode === MODES.stickyBottom) {
        // Element sticks to bottom of viewport
        if (bottom) {
          // node.style.bottom = `${offsetBottom}px`; // original line from react-sticky-box (broken)
          // for some reason "bottom" positioning doesn't do anything but "top" does, so we mimic "bottom" behavior via "top" by using `top: 100% - height - offsetBottom`
          node.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          node.style.top = `${viewPortHeight - nodeHeight - offsetBottom}px`;
        }
      } else {
        // Element sticks to top of viewport (stickyTop)
        if (bottom) {
          node.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          node.style.top = `${offsetTop}px`;
        }
      }
    }
  };
  changeMode(mode);

  /**
   * Handles scroll events and determines when to change sticky modes.
   * This is the main scroll handler that manages sticky state transitions.
   *
   * @param scrollY - Current scroll position
   */
  const onScroll = (scrollY: number) => {
    // Skip if scroll position hasn't changed
    if (scrollY === latestScrollY) return;

    // Calculate scroll direction and update latest position
    const scrollDelta = scrollY - latestScrollY;
    latestScrollY = scrollY;

    // Small mode doesn't need scroll handling
    if (mode === MODES.small) return;

    // Get current dimensions
    const { offsetTop: scrollPaneOffset, height: viewPortHeight } =
      scrollPaneDims;
    const { naturalTop, height: parentHeight } = parentDims;
    const { height: nodeHeight } = nodeDims;

    // Check if we should wait for sticky behavior (waitUntil logic)
    const isScrollingDown = scrollDelta > 0;
    const shouldWait = shouldWaitForSticky(
      waitUntil,
      scrollY,
      naturalTop,
      nodeHeight,
      viewPortHeight,
      offsetTop,
      offsetBottom,
      bottom,
      isScrollingDown
    );

    // Apply hysteresis to prevent flickering at transition boundaries
    const currentStickyState = !shouldWait;
    if (currentStickyState !== lastStickyState) {
      // Only allow state change if we've moved beyond the buffer zone
      const shouldWaitWithBuffer = shouldWaitForSticky(
        waitUntil,
        scrollY + (currentStickyState ? -HYSTERESIS_BUFFER : HYSTERESIS_BUFFER),
        naturalTop,
        nodeHeight,
        viewPortHeight,
        offsetTop,
        offsetBottom,
        bottom,
        isScrollingDown
      );

      // If the buffered check gives a different result, maintain current state
      if (shouldWaitWithBuffer !== shouldWait) {
        return; // Keep current mode
      }

      // Update last sticky state
      lastStickyState = currentStickyState;
    }

    // If waiting, ensure element is in relative mode
    if (shouldWait) {
      if (mode !== MODES.relative) {
        changeMode(MODES.relative);
      }
      return;
    }

    if (scrollDelta > 0) {
      // scroll down
      if (mode === MODES.stickyTop) {
        if (scrollY + scrollPaneOffset + offsetTop > naturalTop) {
          const topOffset = Math.max(
            0,
            scrollPaneOffset + latestScrollY - naturalTop + offsetTop
          );

          if (
            scrollY + scrollPaneOffset + viewPortHeight <=
            naturalTop + nodeHeight + topOffset + offsetBottom
          ) {
            changeMode(MODES.relative);
          } else {
            changeMode(MODES.stickyBottom);
          }
        }
      } else if (mode === MODES.relative) {
        if (isBoxTooLow(scrollY)) changeMode(MODES.stickyBottom);
      }
    } else {
      // scroll up
      if (mode === MODES.stickyBottom) {
        if (
          scrollPaneOffset + scrollY + viewPortHeight <
          naturalTop + parentHeight + offsetBottom
        ) {
          const bottomOffset = Math.max(
            0,
            scrollPaneOffset +
              latestScrollY +
              viewPortHeight -
              (naturalTop + nodeHeight + offsetBottom)
          );

          if (
            scrollPaneOffset + scrollY + offsetTop >=
            naturalTop + bottomOffset
          ) {
            console.log("BACK TO NATURAL POSITION");
            changeMode(MODES.relative);
          } else {
            console.log("FROM STICKY BOTTOM TO STICKY TOP");
            changeMode(MODES.stickyTop);
          }
        }
      } else if (mode === MODES.relative) {
        if (
          scrollPaneOffset + scrollY + offsetTop <
          naturalTop + relativeOffset
        ) {
          console.log("FROM RELATIVE TO STICKY TOP");
          changeMode(MODES.stickyTop);
        }
      }
    }
  };

  const handleScroll =
    scrollPane === window
      ? () => onScroll(window.scrollY)
      : () => onScroll((scrollPane as HTMLElement).scrollTop);

  scrollPane.addEventListener("scroll", handleScroll, passiveArg);
  scrollPane.addEventListener("mousewheel", handleScroll, passiveArg);
  unsubs.push(
    () => scrollPane.removeEventListener("scroll", handleScroll),
    () => scrollPane.removeEventListener("mousewheel", handleScroll)
  );
};

export type StickyBoxConfig = {
  offsetTop?: number;
  offsetBottom?: number;
  bottom?: boolean;
  waitUntil?: string;
};

export type UseStickyBoxOptions = StickyBoxConfig;

export const useStickyBox = ({
  offsetTop = 0,
  offsetBottom = 0,
  bottom = false,
  waitUntil,
}: StickyBoxConfig = {}) => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!node || !stickyProp) return;
    const unsubs: UnsubList = [];
    setup(node, unsubs, { offsetBottom, offsetTop, bottom, waitUntil });
    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [node, offsetBottom, offsetTop, bottom, waitUntil]);

  return setNode;
};

export type StickyBoxCompProps = StickyBoxConfig &
  Pick<ComponentProps<"div">, "children" | "className" | "style">;

const StickyBox = (props: StickyBoxCompProps) => {
  const {
    offsetTop,
    offsetBottom,
    bottom,
    waitUntil,
    children,
    className,
    style,
  } = props;
  const ref = useStickyBox({ offsetTop, offsetBottom, bottom, waitUntil });

  return (
    <div className={className} style={style} ref={ref}>
      {children}
    </div>
  );
};

export default StickyBox;

// ============================================================================
// V2 EXPORTS
// ============================================================================

export * from "./v2";
