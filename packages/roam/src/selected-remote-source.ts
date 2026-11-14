import thinkingSource from "../../db-core/src/thinking.ts?raw";
import selectedSource from "./selected-files.ts?raw";

// These programs run before the destination has the workspace packages installed.
const pieces = selectedSource.split('import { isThinkingLevel } from "@spider/db-core";');
if (pieces.length !== 2) throw new Error("Cannot assemble selected files program");
export const selectedRemoteSource: string = pieces.join(thinkingSource);
