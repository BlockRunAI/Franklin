import typescriptEslint from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const browserGlobals = {
  Blob: "readonly",
  File: "readonly",
  FileReader: "readonly",
  FormData: "readonly",
  HTMLTextAreaElement: "readonly",
  Image: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  Notification: "readonly",
  URL: "readonly",
  WebSocket: "readonly",
  alert: "readonly",
  atob: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  confirm: "readonly",
  crypto: "readonly",
  document: "readonly",
  fetch: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  requestAnimationFrame: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  window: "readonly",
};

export default [
  {
    ignores: ["dist", "node_modules"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: typescriptParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: browserGlobals,
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...typescriptEslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
