/*
 * A newt window: a grey panel in a single-line border, its title set into
 * the top border, and a shadow one cell to the right and one row below.
 *
 *   ┌──────────┤ Title ├──────────┐
 *   │                             │▒
 *   └─────────────────────────────┘▒
 *     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 * The shadow lies outside the window's own box and takes no part in layout:
 * leave a free column and row there, or have an `overflow="hidden"` ancestor
 * clip it. Without colour (see theme.ts) there is no shadow and the panel is
 * only blanked, never painted.
 */
import type { ReactNode } from "react";
import { Box, SurfaceProvider, Text } from "../ink.js";
import { borderStyle, frame, overlayFill, palette, shadowBelow, styled } from "../theme.js";
import { truncate, width as textWidth } from "../text.js";

export interface WindowProps {
    readonly title?: string;
    /** Outer width, border included. */
    readonly width: number;
    /** Outer height, border included; omit to fit the content. */
    readonly height?: number;
    readonly maxHeight?: number;
    /** Colour of the border; the window's text colour when omitted. */
    readonly borderColor?: string;
    /** Background of what the window lies on, seen through the lower half of the row its shadow is in. */
    readonly shadowOn?: string;
    readonly paddingX?: number;
    readonly children?: ReactNode;
}

/** Columns a window's border and padding take from its width. */
export function windowInnerWidth(outer: number, paddingX = 1): number {
    return Math.max(1, outer - 2 - 2 * paddingX);
}

/** The top border, split around the title: "┌───┤ ", "Title", " ├───┐". */
export function topBorder(title: string, width: number): [string, string, string] {
    const room = width - 2;
    // Corners, the two title brackets and a space each side of the title.
    const shown = title && room >= 6 ? truncate(title, room - 4) : "";
    if (!shown)
        return [frame.topLeft + frame.horizontal.repeat(Math.max(0, room)) + frame.topRight, "", ""];
    const rest = room - textWidth(shown) - 4;
    const left = Math.floor(rest / 2);
    return [
        `${frame.topLeft}${frame.horizontal.repeat(left)}${frame.titleLeft} `,
        shown,
        ` ${frame.titleRight}${frame.horizontal.repeat(rest - left)}${frame.topRight}`,
    ];
}

/**
 * The shadow of a window `width` columns wide, as absolutely positioned
 * children of the box that is exactly the window: a column at its right, and
 * half a row below (see shadowBelow).
 */
export function Shadow({ width, on = palette.window.bg }: { width: number, on?: string }) {
    if (!styled)
        return null;
    if (shadowBelow === null) {
        return (
            <>
                <Box position="absolute" top={1} bottom={-1} right={-1} width={1} backgroundColor={palette.shadow} />
                <Box position="absolute" left={1} right={-1} bottom={-1} height={1} backgroundColor={palette.shadow} />
            </>
        );
    }
    return (
        <>
            <Box position="absolute" top={1} bottom={0} right={-1} width={1} backgroundColor={palette.shadow} />
            <Box position="absolute" left={1} right={-1} bottom={-1} height={1}>
                <Text color={palette.shadow} backgroundColor={on} wrap="truncate">{shadowBelow.repeat(width)}</Text>
            </Box>
        </>
    );
}

export function Window({ title = "", width, height, maxHeight, borderColor, shadowOn, paddingX = 1, children }: WindowProps) {
    const fill = styled ? palette.window.bg : overlayFill;
    const edge = borderColor && borderColor !== "none" ? borderColor : styled ? palette.window.fg : undefined;
    const titleColor = styled ? palette.title : undefined;
    const [left, name, right] = topBorder(title, width);
    return (
        <SurfaceProvider fg={palette.window.fg}>
            {/* The outer box is the one a parent may stretch; the inner one is
                always exactly the window, so the shadow hangs off the window. */}
            <Box flexDirection="column" width={width} flexShrink={0}>
            <Box flexDirection="column" width={width} flexShrink={0}>
                <Box width={width} height={1} flexShrink={0} backgroundColor={fill}>
                    <Text color={edge} wrap="truncate">
                        {left}
                        <Text bold color={borderColor ?? titleColor}>{name}</Text>
                        {right}
                    </Text>
                </Box>
                <Box width={width} flexDirection="column" overflow="hidden" paddingX={paddingX}
                     {...(height !== undefined ? { height: Math.max(1, height - 1) } : {})}
                     {...(maxHeight !== undefined ? { maxHeight: Math.max(2, maxHeight - 1) } : {})}
                     borderStyle={borderStyle} borderTop={false} backgroundColor={fill}
                     {...(edge ? { borderColor: edge } : {})}
                     {...(styled ? { borderBackgroundColor: palette.window.bg } : {})}>
                    {children}
                </Box>
                <Shadow width={width} {...(shadowOn ? { on: shadowOn } : {})} />
            </Box>
            </Box>
        </SurfaceProvider>
    );
}
