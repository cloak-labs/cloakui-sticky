import { ComponentProps, useEffect, useState } from "react";

// ============================================================================
// TYPES
// ============================================================================

type StickyState = "relative" | "sticky-top" | "sticky-bottom" | "small";
type ScrollDirection = "up" | "down" | "none";

type StickyConfig = {
  offsetTop: number;
  offsetBottom: number;
  bottom?: boolean;
  waitUntil?: string;
  waitUntilBidirectional?: boolean;
};

type ElementDimensions = {
  naturalTop: number;
  nodeHeight: number;
  viewPortHeight: number;
  parentHeight: number;
  scrollPaneOffset: number;
};

// ============================================================================
// UTILITIES
// ============================================================================

const getScrollParent = (node: HTMLElement): HTMLElement | Window => {
  let parent: HTMLElement | null = node;
  while ((parent = parent.parentElement)) {
    const overflowYVal = getComputedStyle(parent, null).getPropertyValue(
      "overflow-y"
    );
    if (parent === document.body) return window;
    if (
      overflowYVal === "auto" ||
      overflowYVal === "scroll" ||
      overflowYVal === "overlay"
    ) {
      return parent;
    }
  }
  return window;
};

const isOffsetElement = (el: HTMLElement): boolean =>
  el.firstChild ? (el.firstChild as HTMLElement).offsetParent === el : true;

const offsetTill = (node: HTMLElement, target: HTMLElement): number => {
  let current = node;
  let offset = 0;
  if (!isOffsetElement(target)) {
    offset += node.offsetTop - target.offsetTop;
    target = node.offsetParent as HTMLElement;
    offset += -node.offsetTop;
  }
  do {
    offset += current.offsetTop;
    current = current.offsetParent as HTMLElement;
  } while (current && current !== target);
  return offset;
};

const getParentNode = (node: HTMLElement): HTMLElement | Window => {
  let currentParent = node.parentElement;
  while (currentParent) {
    const style = getComputedStyle(currentParent, null);
    if (style.getPropertyValue("display") !== "contents") break;
    currentParent = currentParent.parentElement;
  }
  return currentParent || window;
};

const getVerticalPadding = (
  node: HTMLElement
): { top: number; bottom: number } => {
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

// ============================================================================
// FEATURE DETECTION
// ============================================================================

let stickyProp: null | string = null;
if (typeof CSS !== "undefined" && CSS.supports) {
  if (CSS.supports("position", "sticky")) stickyProp = "sticky";
  else if (CSS.supports("position", "-webkit-sticky"))
    stickyProp = "-webkit-sticky";
}

// ============================================================================
// PASSIVE EVENT LISTENER SUPPORT
// ============================================================================

const passiveArg = (() => {
  let passive = false;
  try {
    const options = Object.defineProperty({}, "passive", {
      get() {
        passive = true;
        return true;
      },
    });
    const emptyHandler = () => {};
    window.addEventListener("testPassive", emptyHandler, options);
    window.removeEventListener("testPassive", emptyHandler, options);
  } catch (e) {
    // Passive not supported
  }
  return passive ? { passive: true } : false;
})();

// ============================================================================
// POSITION CALCULATOR
// ============================================================================

class PositionCalculator {
  private parseWaitUntil(waitUntil: string): {
    value: number;
    isPercentage: boolean;
  } {
    return {
      value: parseFloat(waitUntil.replace(/[^\d.]/g, "")),
      isPercentage: waitUntil.includes("%"),
    };
  }

  public shouldWaitForSticky(
    config: StickyConfig,
    scrollPosition: number,
    dimensions: ElementDimensions,
    scrollDirection: ScrollDirection,
    currentState: StickyState,
    wasSticky: boolean
  ): boolean {
    if (!config.waitUntil) return false;

    const { value, isPercentage } = this.parseWaitUntil(config.waitUntil);
    const { naturalTop, nodeHeight, viewPortHeight } = dimensions;
    const { offsetTop, offsetBottom, bottom, waitUntilBidirectional } = config;

    // Calculate normal sticky trigger point
    const normalStickyTriggerPoint = bottom
      ? naturalTop - viewPortHeight + nodeHeight + offsetBottom
      : naturalTop - offsetTop;

    // Calculate the additional wait distance
    const additionalWaitDistance = isPercentage
      ? (value / 100) * viewPortHeight
      : value;

    // If bidirectional is enabled, apply waitUntil logic in both directions
    if (waitUntilBidirectional) {
      const actualStickyTriggerPoint =
        normalStickyTriggerPoint + additionalWaitDistance;

      return scrollPosition < actualStickyTriggerPoint;
    }

    // Default behavior: waitUntil only applies when scrolling DOWN
    if (scrollDirection === "down") {
      const actualStickyTriggerPoint =
        normalStickyTriggerPoint + additionalWaitDistance;
      return scrollPosition < actualStickyTriggerPoint;
    } else {
      // When scrolling UP, use normal trigger point (no additional wait)
      return scrollPosition < normalStickyTriggerPoint;
    }
  }

  public isBoxTooLow(
    scrollPosition: number,
    dimensions: ElementDimensions,
    config: StickyConfig,
    relativeOffset: number
  ): boolean {
    const { scrollPaneOffset, viewPortHeight, naturalTop, nodeHeight } =
      dimensions;
    const { offsetBottom } = config;

    return (
      scrollPosition + scrollPaneOffset + viewPortHeight >=
      naturalTop + nodeHeight + relativeOffset + offsetBottom
    );
  }

  public shouldBeSmall(
    dimensions: ElementDimensions,
    config: StickyConfig
  ): boolean {
    const { viewPortHeight } = dimensions;
    const { offsetTop, offsetBottom } = config;
    return dimensions.nodeHeight + offsetTop + offsetBottom <= viewPortHeight;
  }
}

// ============================================================================
// STATE MANAGER
// ============================================================================

class StateManager {
  private positionCalculator = new PositionCalculator();
  private currentState: StickyState = "relative";
  private relativeOffset = 0;
  private lastStickyState = false;
  private readonly HYSTERESIS_BUFFER = 2;
  private wasSticky = false; // Track if we were ever sticky in this scroll cycle

  public getCurrentState(): StickyState {
    return this.currentState;
  }

  public getRelativeOffset(): number {
    return this.relativeOffset;
  }

  public updateCurrentState(newState: StickyState): void {
    this.currentState = newState;
  }

  public calculateNextState(
    config: StickyConfig,
    scrollPosition: number,
    dimensions: ElementDimensions,
    scrollDirection: ScrollDirection
  ): StickyState {
    // Check if we should wait for sticky behavior
    const shouldWait = this.positionCalculator.shouldWaitForSticky(
      config,
      scrollPosition,
      dimensions,
      scrollDirection,
      this.currentState,
      this.wasSticky
    );

    // Apply hysteresis to prevent flickering, but only when transitioning between sticky and non-sticky
    const currentStickyState = !shouldWait;

    // Only apply hysteresis if we're currently in a sticky state and trying to transition to relative
    if (this.currentState !== "relative" && shouldWait) {
      const shouldWaitWithBuffer = this.positionCalculator.shouldWaitForSticky(
        config,
        scrollPosition + this.HYSTERESIS_BUFFER,
        dimensions,
        scrollDirection,
        this.currentState,
        this.wasSticky
      );

      if (!shouldWaitWithBuffer) {
        return this.currentState; // Keep current state
      }
    }

    // Only apply hysteresis if we're currently in relative state and trying to transition to sticky
    if (this.currentState === "relative" && !shouldWait) {
      const shouldWaitWithBuffer = this.positionCalculator.shouldWaitForSticky(
        config,
        scrollPosition - this.HYSTERESIS_BUFFER,
        dimensions,
        scrollDirection,
        this.currentState,
        this.wasSticky
      );

      if (shouldWaitWithBuffer) {
        return this.currentState; // Keep current state
      }
    }

    this.lastStickyState = currentStickyState;

    if (shouldWait) {
      // Reset hysteresis state when we should wait
      // This ensures waitUntil works correctly on subsequent scroll cycles
      this.lastStickyState = false;
      this.wasSticky = false;
      return "relative";
    }

    if (this.positionCalculator.shouldBeSmall(dimensions, config)) {
      this.wasSticky = true;
      return "small";
    }

    if (
      this.positionCalculator.isBoxTooLow(
        scrollPosition,
        dimensions,
        config,
        this.relativeOffset
      )
    ) {
      this.wasSticky = true;
      return "sticky-bottom";
    }

    return "relative";
  }

  public updateRelativeOffset(
    newState: StickyState,
    prevState: StickyState,
    scrollPosition: number,
    dimensions: ElementDimensions,
    config: StickyConfig
  ): void {
    if (prevState === "relative") {
      this.relativeOffset = -1;
    }

    if (newState === "relative") {
      const { scrollPaneOffset, viewPortHeight, naturalTop, nodeHeight } =
        dimensions;
      const { offsetTop, offsetBottom, bottom } = config;

      this.relativeOffset =
        prevState === "sticky-top"
          ? Math.max(
              0,
              scrollPaneOffset + scrollPosition - naturalTop + offsetTop
            )
          : Math.max(
              0,
              scrollPaneOffset +
                scrollPosition +
                viewPortHeight -
                (naturalTop + nodeHeight + offsetBottom)
            );
    }
  }
}

// ============================================================================
// DOM CONTROLLER
// ============================================================================

class DOMController {
  private element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    // Set default top: 0 to provide a starting point for CSS transitions
    this.element.style.top = "0px";

    // Add CSS optimizations to reduce layout jank
    this.element.style.willChange = "top";
    this.element.style.contain = "layout";
  }

  public applyState(
    newState: StickyState,
    prevState: StickyState,
    config: StickyConfig,
    dimensions: ElementDimensions,
    relativeOffset: number,
    scrollPosition: number
  ): void {
    // Add transition when state changes
    if (prevState !== newState) {
      this.element.style.transition = "top 0.3s ease";
    }

    // Ensure we always have a starting point for transitions
    if (this.element.style.top === "") {
      this.element.style.top = "0px";
    }

    // Use requestAnimationFrame to defer state changes and reduce jank
    requestAnimationFrame(() => {
      this.applyStateImmediate(
        newState,
        prevState,
        config,
        dimensions,
        relativeOffset,
        scrollPosition
      );
    });
  }

  private applyStateImmediate(
    newState: StickyState,
    prevState: StickyState,
    config: StickyConfig,
    dimensions: ElementDimensions,
    relativeOffset: number,
    scrollPosition: number
  ): void {
    const { nodeHeight, viewPortHeight } = dimensions;
    const { offsetTop, offsetBottom, bottom } = config;

    // Update data-sticky attribute based on state
    const isSticky =
      newState === "sticky-top" ||
      newState === "sticky-bottom" ||
      newState === "small";
    this.element.setAttribute("data-sticky", isSticky.toString());

    switch (newState) {
      case "small":
        this.element.style.position = stickyProp as string;
        if (bottom) {
          this.element.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          this.element.style.top = `${offsetTop}px`;
        }
        break;

      case "relative":
        // this.element.style.position = "relative";

        // Check if we've scrolled back to natural position
        const isAtNaturalPosition =
          scrollPosition === 0 ||
          (bottom
            ? scrollPosition >=
              dimensions.naturalTop - viewPortHeight + nodeHeight + offsetBottom
            : scrollPosition <= dimensions.naturalTop - offsetTop);

        // If we're transitioning from a sticky state to relative, always reset top to 0px
        // This ensures smooth transitions on subsequent scroll cycles
        if (prevState !== "relative" || isAtNaturalPosition) {
          this.element.style.top = "0px";
          this.element.style.bottom = "";
        } else {
          if (bottom) {
            this.element.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
          } else {
            this.element.style.top = `${relativeOffset}px`;
          }
        }
        break;

      case "sticky-bottom":
        this.element.style.position = stickyProp as string;
        if (bottom) {
          this.element.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          this.element.style.top = `${
            viewPortHeight - nodeHeight - offsetBottom
          }px`;
        }
        break;

      case "sticky-top":
        this.element.style.position = stickyProp as string;
        if (bottom) {
          this.element.style.top = `calc(100% - ${nodeHeight}px - ${offsetBottom}px)`;
        } else {
          this.element.style.top = `${offsetTop}px`;
        }
        break;
    }
  }
}

// ============================================================================
// SCROLL TRACKER
// ============================================================================

class ScrollTracker {
  private scrollPane: HTMLElement | Window;
  private currentScrollPosition: number;
  private lastScrollPosition: number;
  private onScroll: (
    scrollPosition: number,
    direction: ScrollDirection
  ) => void;

  constructor(
    scrollPane: HTMLElement | Window,
    onScroll: (scrollPosition: number, direction: ScrollDirection) => void
  ) {
    this.scrollPane = scrollPane;
    this.onScroll = onScroll;
    this.currentScrollPosition = this.getScrollPosition();
    this.lastScrollPosition = this.currentScrollPosition;
  }

  private getScrollPosition(): number {
    return this.scrollPane === window
      ? window.scrollY
      : (this.scrollPane as HTMLElement).scrollTop;
  }

  private handleScroll = (): void => {
    this.currentScrollPosition = this.getScrollPosition();
    if (this.currentScrollPosition === this.lastScrollPosition) return;

    const direction: ScrollDirection =
      this.currentScrollPosition > this.lastScrollPosition ? "down" : "up";
    this.onScroll(this.currentScrollPosition, direction);
    this.lastScrollPosition = this.currentScrollPosition;
  };

  public start(): void {
    this.scrollPane.addEventListener("scroll", this.handleScroll, passiveArg);
    this.scrollPane.addEventListener(
      "mousewheel",
      this.handleScroll,
      passiveArg
    );
  }

  public stop(): void {
    this.scrollPane.removeEventListener("scroll", this.handleScroll);
    this.scrollPane.removeEventListener("mousewheel", this.handleScroll);
  }
}

// ============================================================================
// DIMENSION TRACKER
// ============================================================================

class DimensionTracker {
  private element: HTMLElement;
  private scrollPane: HTMLElement | Window;
  private onDimensionsChange: (dimensions: ElementDimensions) => void;
  private unsubs: (() => void)[] = [];

  constructor(
    element: HTMLElement,
    scrollPane: HTMLElement | Window,
    onDimensionsChange: (dimensions: ElementDimensions) => void
  ) {
    this.element = element;
    this.scrollPane = scrollPane;
    this.onDimensionsChange = onDimensionsChange;
  }

  public start(): void {
    // Track scroll pane dimensions
    const updateScrollPaneDims = () => {
      const { height } =
        this.scrollPane === window
          ? { height: window.innerHeight }
          : (this.scrollPane as HTMLElement).getBoundingClientRect();
      this.updateDimensions({ viewPortHeight: height });
    };

    // Track parent dimensions
    const updateParentDims = () => {
      const parent = getParentNode(this.element);
      const parentPaddings =
        parent === window
          ? { top: 0, bottom: 0 }
          : getVerticalPadding(parent as HTMLElement);

      const parentRect =
        parent === window
          ? { top: 0, height: window.innerHeight }
          : (parent as HTMLElement).getBoundingClientRect();

      this.updateDimensions({
        parentHeight:
          parentRect.height - parentPaddings.top - parentPaddings.bottom,
        scrollPaneOffset:
          parent === window
            ? 0
            : offsetTill(this.element, parent as HTMLElement),
      });
    };

    // Track element dimensions
    const updateElementDims = () => {
      const rect = this.element.getBoundingClientRect();
      this.updateDimensions({
        naturalTop: rect.top + window.scrollY,
        nodeHeight: rect.height,
      });
    };

    const updateAllDimensions = () => {
      updateScrollPaneDims();
      updateParentDims();
      updateElementDims();
    };

    // Initial update
    updateAllDimensions();

    // Set up observers
    if (window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(() => {
        updateAllDimensions();
      });

      resizeObserver.observe(this.element);
      if (this.scrollPane !== window) {
        resizeObserver.observe(this.scrollPane as HTMLElement);
      }

      this.unsubs.push(() => resizeObserver.disconnect());
    }

    // Set up event listeners
    const handler = () => updateAllDimensions();
    window.addEventListener("resize", handler);
    this.unsubs.push(() => window.removeEventListener("resize", handler));
  }

  private currentDimensions: ElementDimensions = {
    naturalTop: 0,
    nodeHeight: 0,
    viewPortHeight: 0,
    parentHeight: 0,
    scrollPaneOffset: 0,
  };

  private updateDimensions(updates: Partial<ElementDimensions>): void {
    const newDimensions = { ...this.currentDimensions, ...updates };

    // Only call onDimensionsChange if dimensions actually changed
    if (
      JSON.stringify(newDimensions) !== JSON.stringify(this.currentDimensions)
    ) {
      this.currentDimensions = newDimensions;
      this.onDimensionsChange(this.currentDimensions);
    }
  }

  public stop(): void {
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
  }
}

// ============================================================================
// STICKY ELEMENT (MAIN ORCHESTRATOR)
// ============================================================================

class StickyElement {
  private element: HTMLElement;
  private config: StickyConfig;
  private stateManager: StateManager;
  private domController: DOMController;
  private scrollTracker: ScrollTracker;
  private dimensionTracker: DimensionTracker;
  private currentDimensions: ElementDimensions | null = null;
  private isDestroyed = false;

  constructor(element: HTMLElement, config: StickyConfig) {
    this.element = element;
    this.config = config;
    this.stateManager = new StateManager();
    this.domController = new DOMController(element);

    const scrollPane = getScrollParent(element);
    this.scrollTracker = new ScrollTracker(
      scrollPane,
      this.handleScroll.bind(this)
    );
    this.dimensionTracker = new DimensionTracker(
      element,
      scrollPane,
      this.handleDimensionsChange.bind(this)
    );
  }

  public start(): void {
    this.scrollTracker.start();
    this.dimensionTracker.start();
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.scrollTracker.stop();
    this.dimensionTracker.stop();
  }

  private handleScroll(
    scrollPosition: number,
    direction: ScrollDirection
  ): void {
    if (this.isDestroyed || !this.currentDimensions) return;

    const prevState = this.stateManager.getCurrentState();
    const nextState = this.stateManager.calculateNextState(
      this.config,
      scrollPosition,
      this.currentDimensions,
      direction
    );

    if (nextState !== prevState) {
      this.stateManager.updateCurrentState(nextState);

      this.stateManager.updateRelativeOffset(
        nextState,
        prevState,
        scrollPosition,
        this.currentDimensions,
        this.config
      );

      this.domController.applyState(
        nextState,
        prevState,
        this.config,
        this.currentDimensions,
        this.stateManager.getRelativeOffset(),
        scrollPosition
      );
    }
  }

  private handleDimensionsChange(dimensions: ElementDimensions): void {
    this.currentDimensions = dimensions;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const createStickyElement = (
  element: HTMLElement,
  config: StickyConfig
): { destroy: () => void } => {
  const stickyElement = new StickyElement(element, config);
  stickyElement.start();

  return {
    destroy: () => stickyElement.destroy(),
  };
};

// ============================================================================
// REACT HOOK
// ============================================================================

export const useStickyBox = ({
  offsetTop = 0,
  offsetBottom = 0,
  bottom = false,
  waitUntil,
  waitUntilBidirectional,
}: StickyConfig) => {
  const [ref, setRef] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!ref) return;

    const { destroy } = createStickyElement(ref, {
      offsetTop,
      offsetBottom,
      bottom,
      waitUntil,
      waitUntilBidirectional,
    });

    return destroy;
  }, [ref, offsetTop, offsetBottom, bottom, waitUntil, waitUntilBidirectional]);

  return setRef;
};

// ============================================================================
// REACT COMPONENT
// ============================================================================

export type StickyBoxProps = StickyConfig &
  Pick<ComponentProps<"div">, "children" | "className" | "style">;

export const StickyBox = ({
  offsetTop,
  offsetBottom,
  bottom,
  waitUntil,
  waitUntilBidirectional,
  children,
  className,
  style,
}: StickyBoxProps) => {
  const setRef = useStickyBox({
    offsetTop,
    offsetBottom,
    bottom,
    waitUntil,
    waitUntilBidirectional,
  });

  return (
    <div ref={setRef} className={className} style={style}>
      {children}
    </div>
  );
};
