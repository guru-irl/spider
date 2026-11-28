export const FOOTER_SNAPSHOT: unique symbol = Symbol.for("spider.usage.footerSnapshot");
export type FooterSnapshot = { [FOOTER_SNAPSHOT]: () => string[] | undefined };
