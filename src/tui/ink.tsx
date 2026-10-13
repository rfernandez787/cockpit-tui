/*
 * Ink's Box and Text, with the newt look applied to Text.
 *
 * Ink hands a Box's background down to the text inside it, but not a
 * foreground: text is drawn in the terminal's own colour, which on a grey
 * window is whatever the user's scheme happens to be. So everything drawn in
 * a window imports Text from here. It gives uncoloured text the window's
 * foreground, and draws `inverse` -- the selected row of a list -- as newt
 * does, in the selection's own colours instead of the window's swapped.
 *
 * When the look is not painted (see theme.ts) this is Ink's Text unchanged.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Box, Text as InkText, type TextProps } from "ink";
import { palette, styled } from "./theme.js";

export { Box, InkText };
export type { TextProps };

interface Surface {
    /** Colour of text that asks for none. */
    readonly fg: string;
}

/** Null: no provider above, which means a window (its colour is read when drawn: the scheme can change). */
const SurfaceContext = createContext<Surface | null>(null);

/** Declare what uncoloured text inside is drawn in: the root's or a window's. */
export function SurfaceProvider({ fg, children }: { fg: string, children: ReactNode }) {
    return <SurfaceContext.Provider value={{ fg }}>{children}</SurfaceContext.Provider>;
}

/** Inside another Text: null at the top, else whether that text is a selection. */
const NestingContext = createContext<{ selected: boolean } | null>(null);

export function Text(props: TextProps) {
    const surface = useContext(SurfaceContext) ?? { fg: palette.window.fg };
    const outer = useContext(NestingContext);
    if (!styled)
        return <InkText {...props} />;

    const { inverse, color, backgroundColor, children, ...rest } = props;
    const selected = inverse === true || outer?.selected === true;
    // In a selection every piece takes its colours: a state's green or red
    // would not read on blue, and Ink would otherwise give nested text the
    // window's background back.
    const fg = selected
        ? palette.selected.fg
        : color && color !== "none" ? color : outer ? undefined : surface.fg;
    const bg = selected ? palette.selected.bg : backgroundColor;
    return (
        <NestingContext.Provider value={{ selected }}>
            <InkText {...rest} {...(fg ? { color: fg } : {})} {...(bg ? { backgroundColor: bg } : {})}>
                {children}
            </InkText>
        </NestingContext.Provider>
    );
}
