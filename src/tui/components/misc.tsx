/*
 * Small presentational pieces shared by pages.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Box, Text } from "../ink.js";
import { colors, glyphs } from "../theme.js";
import { usePrivilege } from "../privilege.js";
import { fit, truncate, width as textWidth, wrap } from "../text.js";
import { errorText } from "../status.js";
import { Spinner } from "./Spinner.js";

/** A section heading: bold title, optional dim detail on the same line. */
export function Heading({ title, detail, width }: { title: string, detail?: string, width: number }) {
    const room = Math.max(0, width - textWidth(title) - 2);
    return (
        <Text wrap="truncate">
            <Text bold color={colors.accent}>{truncate(title, width)}</Text>
            {detail && room > 0 ? <Text color={colors.dim}>{"  " + truncate(detail, room)}</Text> : null}
        </Text>
    );
}

export interface Field {
    readonly label: string;
    readonly value: string;
    readonly color?: string;
}

/** Aligned "label  value" rows. Values must already be clean. */
export function Fields({ fields, width, labelWidth }: { fields: readonly Field[], width: number, labelWidth?: number }) {
    const labels = labelWidth ?? Math.min(24, Math.max(0, ...fields.map(f => textWidth(f.label))) + 2);
    const valueWidth = Math.max(0, width - labels);
    return (
        <Box flexDirection="column" width={width}>
            {fields.map((field, i) => (
                <Text key={i} wrap="truncate">
                    <Text color={colors.dim}>{fit(field.label, labels)}</Text>
                    <Text color={field.color}>{fit(field.value, valueWidth)}</Text>
                </Text>
            ))}
        </Box>
    );
}

/** A message filling an area: empty states, loading, errors. */
export function Notice({ width, height, children, color, loading }: {
    width: number, height: number, children: string, color?: string, loading?: boolean,
}) {
    const lines = wrap(children, Math.max(1, width - 4));
    return (
        <Box width={width} height={height} flexDirection="column" paddingX={2} paddingTop={1}>
            {loading ? <Spinner label={lines[0] ?? ""} /> : lines.map((line, i) => <Text key={i} color={color}>{line}</Text>)}
            {loading ? lines.slice(1).map((line, i) => <Text key={i}>{line}</Text>) : null}
        </Box>
    );
}

interface BoundaryProps {
    readonly width: number;
    readonly height: number;
    readonly name: string;
    readonly children: ReactNode;
    readonly onError?: (error: unknown, info: ErrorInfo) => void;
}

interface BoundaryState {
    readonly error: unknown;
}

/**
 * Contain a crashing page: show what went wrong in its area and keep the rest
 * of the app usable, instead of tearing down the terminal.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    override state: BoundaryState = { error: null };

    static getDerivedStateFromError(error: unknown): BoundaryState {
        return { error };
    }

    override componentDidCatch(error: unknown, info: ErrorInfo): void {
        this.props.onError?.(error, info);
    }

    override render(): ReactNode {
        if (this.state.error === null)
            return this.props.children;
        return (
            <Notice width={this.props.width} height={this.props.height} color={colors.error}>
                {`The ${this.props.name} page failed: ${errorText(this.state.error)}. ` +
                 "Switch pages and back to retry; the log has details."}
            </Notice>
        );
    }
}

/**
 * A row of tab labels. The current one is bracketed as well as highlighted,
 * so it reads correctly with no styling at all.
 */
export function Tabs({ tabs, current, width }: { tabs: readonly string[], current: number, width: number }) {
    let used = 0;
    const shown: { tab: string, index: number }[] = [];
    for (const [index, tab] of tabs.entries()) {
        const cell = textWidth(tab) + 2 + (index > 0 ? 1 : 0);
        if (used + cell > width)
            break;
        used += cell;
        shown.push({ tab, index });
    }
    return (
        <Text wrap="truncate">
            {shown.map(({ tab, index }) => (
                <Text key={tab}>
                    {index > 0 ? " " : ""}
                    {index === current
                        ? <Text bold color={colors.accent}>{`[${tab}]`}</Text>
                        : <Text color={colors.dim}>{` ${tab} `}</Text>}
                </Text>
            ))}
        </Text>
    );
}

/**
 * One line telling the user why actions are missing, on pages that have
 * privileged actions. Shown only when escalation is possible but not active.
 */
export function LimitedAccessBanner({ width }: { width: number }) {
    const privilege = usePrivilege();
    if (privilege.allowed !== false || privilege.configured !== true)
        return null;
    return (
        <Text color={colors.warning} wrap="truncate">
            {fit(`${glyphs.warning} Limited access: press A to turn on administrative access.`, width)}
        </Text>
    );
}
