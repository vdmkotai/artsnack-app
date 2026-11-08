"use client";

import * as React from "react";
import { Ellipsis } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import styles from "./preview-density.module.css";

/**
 * Whether the tile around a control has been hovered or focused yet.
 *
 * A Base UI tooltip trigger is not a cheap button: each one brings its own
 * store, floating-ui context and hover listeners, and a grid tile carried five
 * or six of them — several hundred on a long results page, almost none of which
 * anyone would ever point at. Tiles therefore start with plain buttons and
 * switch to the tooltip versions the first time a mouse enters them, which is
 * always before the pointer can reach a button inside.
 */
const TileTipsContext = React.createContext(false);

export const TileTipsProvider = TileTipsContext.Provider;

/**
 * Decides whether an event on the tile itself should arm its tooltips.
 *
 * Mouse only: arming swaps each button for its tooltip twin, and doing that
 * between a touch's pointerdown and its click would swallow the tap. Never while
 * focus is already on a control inside the tile — the swap would drop it — and
 * on focus only when the tile itself is what got it, which keyboard users reach
 * before its buttons.
 */
export function shouldArmTileTips(event: React.PointerEvent | React.FocusEvent): boolean {
  const tile = event.currentTarget;
  if ("pointerType" in event) {
    if (event.pointerType !== "mouse") return false;
    const focused = document.activeElement;
    return !(focused && focused !== tile && tile.contains(focused));
  }
  return event.target === tile;
}

type TipButtonProps = Omit<React.ComponentProps<"button">, "children" | "onClick"> & {
  /** Accessible name, and the tooltip text unless `tip` says otherwise. */
  label: string;
  tip?: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Called after the click is kept from reaching the tile underneath. */
  onPress: () => void;
  children: React.ReactNode;
};

/** An icon button on a grid tile, with a tooltip once the tile is armed. */
export function TipButton({
  label,
  tip,
  side = "bottom",
  onPress,
  children,
  ...buttonProps
}: TipButtonProps) {
  const armed = React.useContext(TileTipsContext);
  const onClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onPress();
  };
  if (!armed) {
    return (
      <button type="button" aria-label={label} onClick={onClick} {...buttonProps}>
        {children}
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger aria-label={label} onClick={onClick} {...buttonProps}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>
        <p>{tip ?? label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A popover that costs nothing until it is first opened.
 *
 * Until then the trigger is a plain button; the first click mounts the real
 * popover already open, and it stays mounted from then on so later openings
 * behave exactly as a normal popover does.
 */
export function useLazyPopover() {
  const [mounted, setMounted] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const openFirst = React.useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  return { mounted, open, setOpen, openFirst };
}

/** Keep actions usable when zoom or the media's aspect ratio makes a tile small. */
export function PreviewActions({ children }: { children: React.ReactNode }) {
  const menu = useLazyPopover();
  return (
    <>
      <div className={styles.inlineActions}>{children}</div>
      <div className={styles.compactActions}>
        {menu.mounted ? (
          <Popover open={menu.open} onOpenChange={(next) => menu.setOpen(next)}>
            <PopoverTrigger
              aria-label="Preview actions"
              className={styles.menuTrigger}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Ellipsis className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className={styles.actionMenu}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <PopoverTitle className="sr-only">Preview actions</PopoverTitle>
              {children}
            </PopoverContent>
          </Popover>
        ) : (
          <button
            type="button"
            aria-label="Preview actions"
            aria-haspopup="dialog"
            className={styles.menuTrigger}
            onClick={(event) => {
              event.stopPropagation();
              menu.openFirst();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        )}
      </div>
    </>
  );
}
