import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "recordings/**",
      ".eforest/tasks/**/work/**",
      ".claude/**",
      ".agents/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        Headers: "readonly",
        performance: "readonly",
        process: "readonly",
        Request: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
