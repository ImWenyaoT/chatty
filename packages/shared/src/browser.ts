/**
 * Browser-safe shared contracts. Keep this entrypoint free of Node built-ins:
 * Client Components must not import the root barrel, which also exports auth.
 */
export * from "./api-contracts.js";
