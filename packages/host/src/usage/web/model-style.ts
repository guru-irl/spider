import type { ModelStyle } from "../dashboard-v4-contract.js";
import { element } from "./dom.js";
/** The display catalogue is circle, diamond, square, triangle, matching every page. */
export function modelShape(shape: ModelStyle["shape"]): ModelStyle["shape"] { return shape === "square" ? "diamond" : shape === "diamond" ? "square" : shape; }
export function renderModelMarker(document: Document, style: ModelStyle): HTMLElement {
  const shapeName = modelShape(style.shape);
  const marker = element(document, "span", undefined, "model-marker"); marker.setAttribute("data-shape", shapeName); marker.setAttribute("aria-label", shapeName); marker.setAttribute("role", "img");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", shapeName === "circle" ? "circle" : "path");
  if (shapeName === "circle") { shape.setAttribute("cx", "8"); shape.setAttribute("cy", "8"); shape.setAttribute("r", "5"); }
  else shape.setAttribute("d", shapeName === "square" ? "M3 3h10v10H3Z" : shapeName === "diamond" ? "M8 1l7 7-7 7-7-7Z" : "M8 2l6 11H2Z");
  shape.setAttribute("fill", /^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "currentColor"); svg.append(shape); marker.append(svg); return marker;
}
