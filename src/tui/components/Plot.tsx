/*
 * Throughput plots as panels: "MiB/s Reading", "Kbps Sending". The drawing
 * is lib/plot.ts; this puts it in a panel with the unit and what is plotted
 * as its title, the current figure in its border, the rate numbered down the
 * left of every row and the time of day along its foot.
 *
 *   ┌─┤ MiB/s Reading ├──────────── 12.3 ─┐
 *   │30               ▂▅                  │
 *   │20           ▁▃▅███▆▃                │
 *   │10 ▁▁▁▁▁▁▂▃▅▇█████████▇▅▂▁▁▁▁▁▁▁▁▁▁▁▁│
 *   │ 0    16:24            16:25         │
 */
import { Box, Text } from "../ink.js";
import { BYTE_UNITS, inUnit, plotRows, plotScale, xLabels, yLabels, type Units } from "../../lib/plot.js";
import { fit, width as textWidth } from "../text.js";
import { colors, unicode } from "../theme.js";
import { Panel, PANEL_EDGE } from "./Panel.js";

/** Rows of plot for a page this tall: more where there is room to spare. */
export function plotHeight(pageHeight: number): number {
    return pageHeight >= 34 ? 4 : pageHeight >= 24 ? 3 : 2;
}

/** What a plot adds under its rows: the line of times. */
const TIME_ROWS = 1;

/** Rows a plot panel takes beyond its rows of plot: the times, the border and the shadow. */
export const PLOT_EXTRA_ROWS = TIME_ROWS + PANEL_EDGE;

export interface PlotData {
    readonly title: string;
    /** Oldest first, in the units' base (bytes or bits per second). */
    readonly samples: readonly number[];
    /** Null until the first rate is in. */
    readonly current: number | null;
}

export function Plot({ title, samples, times, current, width, rows, units = BYTE_UNITS }: PlotData & {
    times: readonly number[], width: number, rows: number, units?: Units,
}) {
    const inner = Math.max(1, width - PANEL_EDGE);
    const scale = plotScale(samples, rows, units);
    const labels = yLabels(scale, rows);
    // The axis: the widest number and a space; "0" stands at the foot, beside the times.
    const axis = Math.max(...labels.map(label => textWidth(label))) + 1;
    const columns = Math.max(0, inner - axis);
    const lines = plotRows(samples, columns, rows, scale, !unicode);
    return (
        <Panel title={`${scale.unitName} ${title}`} detail={current === null ? "" : inUnit(current, scale)}
               width={width} height={rows + PLOT_EXTRA_ROWS}>
            {lines.map((line, i) => (
                <Text key={i} wrap="truncate">
                    <Text color={colors.dim}>{fit(labels[i] ?? "", axis - 1, "right")} </Text>
                    <Text color={colors.accent}>{line}</Text>
                </Text>
            ))}
            <Text color={colors.dim} wrap="truncate">{fit("0", axis - 1, "right")} {xLabels(times, columns)}</Text>
        </Panel>
    );
}

/** Two plots side by side, as wide as the page, on one time axis. */
export function PlotPair({ left, right, times, width, rows, units }: {
    left: PlotData, right: PlotData, times: readonly number[], width: number, rows: number, units?: Units,
}) {
    const half = Math.floor(width / 2);
    return (
        <Box flexDirection="row" width={width} height={rows + PLOT_EXTRA_ROWS} flexShrink={0}>
            <Plot {...left} times={times} width={half} rows={rows} {...(units ? { units } : {})} />
            <Plot {...right} times={times} width={width - half} rows={rows} {...(units ? { units } : {})} />
        </Box>
    );
}
