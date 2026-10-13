/*
 * A panel: a sub-window of the page, drawn inside the shell's window.
 *
 *   ┌─┤ Usage ├──────── updating… ─┐
 *   │  CPU     [█░░░░░░░]  1%      │▒
 *   └──────────────────────────────┘▒
 *     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *
 * It is a small window on the same grey, with the window's shadow: its
 * title sits at the left of the top border, in the accent colour, with an
 * optional dim detail at the right. Unlike a Window's, the shadow is part of
 * the panel's own width and height -- its last column and row -- so panels
 * can be stacked and set side by side without one's shadow falling on the
 * next. Without colour the column and row are there, and empty. Pages stack panels to give each part of their content -- a
 * filter line, a table, a group of fields -- a frame of its own.
 *
 * Panels cost three rows and three columns each, so they are drawn only when the
 * page has them to spare (panelled()); below that a page is laid out as
 * plain lines, and <Panel plain> draws nothing but its children.
 */
import type { ReactNode } from "react";
import { Box, Text } from "../ink.js";
import { borderStyle, colors, frame, palette, styled } from "../theme.js";
import { truncate, width as textWidth } from "../text.js";
import { Shadow } from "./Window.js";

/** Columns, and rows, a panel takes from what it frames: the border and the shadow. */
export const PANEL_EDGE = 3;

/** The page size from which its content is framed in panels. */
export const PANEL_MIN_COLUMNS = 56;
export const PANEL_MIN_ROWS = 16;

/*
 * COCKPIT_TUI_PANELS=0 keeps every page to plain lines whatever its size: a
 * slow line has less to draw. (Tests of a page's lines switch it off too.)
 */
let enabled = !/^(0|false)$/.test(process.env.COCKPIT_TUI_PANELS ?? "");

export function setPanels(on: boolean): void {
    enabled = on;
}

export function panelsEnabled(): boolean {
    return enabled;
}

/** Whether a page of this size draws its content in panels. */
export function panelled(width: number, height: number): boolean {
    return enabled && width >= PANEL_MIN_COLUMNS && height >= PANEL_MIN_ROWS;
}

/**
 * The top border, split around the title and the detail:
 * "┌─┤ ", "Title", " ├────", " detail ", "─┐". The detail goes first when
 * they do not both fit, then the title is cut, then dropped.
 */
export function panelTop(title: string, width: number, detail = ""): [string, string, string, string, string] {
    const room = Math.max(0, width - 2);
    // A dash, the two title brackets and a space each side of the title.
    const shown = title && room >= 7 ? truncate(title, room - 6) : "";
    if (!shown)
        return [frame.topLeft + frame.horizontal.repeat(room), "", "", "", frame.topRight];
    const rest = room - textWidth(shown) - 5;
    // The detail, a space each side, and a dash before the corner.
    const note = detail && textWidth(detail) + 3 < rest ? ` ${detail} ` : "";
    const tail = note ? frame.horizontal : "";
    return [
        `${frame.topLeft}${frame.horizontal}${frame.titleLeft} `,
        shown,
        ` ${frame.titleRight}${frame.horizontal.repeat(rest - textWidth(note) - tail.length)}`,
        note,
        tail + frame.topRight,
    ];
}

/** The bottom border. */
export function panelBottom(width: number): string {
    return frame.bottomLeft + frame.horizontal.repeat(Math.max(0, width - 2)) + frame.bottomRight;
}

export interface PanelProps {
    readonly title: string;
    /** Dim text at the right of the top border: a count, the keys that act here. */
    readonly detail?: string;
    /** Outer width, border and shadow included. */
    readonly width: number;
    /** Outer height, border and shadow included. */
    readonly height: number;
    /** No frame: only the children, as lines of the page. */
    readonly plain?: boolean;
    readonly children?: ReactNode;
}

export function Panel({ title, detail, width, height, plain = false, children }: PanelProps) {
    if (plain)
        return <>{children}</>;
    const edge = styled ? palette.window.fg : undefined;
    // The frame, inside the column and the row its shadow falls on.
    const outerWidth = width;
    const outerHeight = height;
    width = Math.max(2, outerWidth - 1);
    height = Math.max(2, outerHeight - 1);
    const [left, name, middle, note, right] = panelTop(title, width, detail);
    return (
        <Box width={outerWidth} height={outerHeight} flexShrink={0}>
        <Box flexDirection="column" width={width} height={height} flexShrink={0}>
            <Box width={width} height={1} flexShrink={0}>
                <Text color={edge} wrap="truncate">
                    {left}
                    <Text bold color={colors.accent}>{name}</Text>
                    {middle}
                    <Text color={colors.dim}>{note}</Text>
                    {right}
                </Text>
            </Box>
            <Box width={width} height={Math.max(1, height - 1)} flexShrink={0}
                 borderStyle={borderStyle} borderTop={false}
                 {...(edge ? { borderColor: edge } : {})}
                 {...(styled ? { borderBackgroundColor: palette.window.bg } : {})}>
                {/* A box of its own inside the border: what is positioned
                    absolutely within the panel is placed against this. */}
                <Box flexDirection="column" width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} overflow="hidden">
                    {children}
                </Box>
            </Box>
            <Shadow width={width} />
        </Box>
        </Box>
    );
}
