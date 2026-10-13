/*
 * Activity indicator for work in flight: loading a list, waiting on sudo.
 */
import { useEffect, useState } from "react";
import { Text } from "../ink.js";
import { colors, glyphs } from "../theme.js";

export function Spinner({ label, color = colors.accent }: { label?: string, color?: string }) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setFrame(n => (n + 1) % glyphs.spinner.length), 100);
        return () => clearInterval(timer);
    }, []);
    return (
        <Text wrap="truncate">
            <Text color={color}>{glyphs.spinner[frame]}</Text>
            {label ? ` ${label}` : ""}
        </Text>
    );
}
