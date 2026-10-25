/** Any model/transport failure, whichever provider produced it. Messages carry the HTTP status as "(503)" so retries can match it. */
export class LlmError extends Error {}
