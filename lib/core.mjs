import { openJev as openGate, describeError as describeGateError } from "decision-gate";
import { SearchError } from "./meaning/search.mjs";

export { searchByMeaning, estimateSearch, SearchError, MAX_INPUT_BYTES } from "./meaning/search.mjs";

export const openJev = (options = {}) => openGate({ ...options, tool: "jevzf" });

export const describeError = (error) => error instanceof SearchError ? error.message.replace(/[\r\x1b]/g, " ") : describeGateError(error);
