import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import noStringConcatPreferTemplate from "./rules/no-string-concat-prefer-template.js";
import noDeprecatedFns from "./rules/no-deprecated-fns.js";
import noJsonStringify from "./rules/no-json-stringify.js";

const customPlugin = {
	rules: {
		"no-string-concat-prefer-template": noStringConcatPreferTemplate,
		"no-deprecated-fns": noDeprecatedFns,
		"no-json-stringify": noJsonStringify,
	},
} as any;

export default defineConfig([
	eslint.configs.recommended,
	...tseslint.configs.strict,
	...tseslint.configs.stylistic,
	{
		rules: {
			// ✅ TypeScript - Type Safety
			"@typescript-eslint/consistent-indexed-object-style": "warn",
			"@typescript-eslint/array-type": "warn",
			"@typescript-eslint/consistent-type-imports": "warn",
			"@typescript-eslint/consistent-type-definitions": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unsafe-function-type": "warn",
			"@typescript-eslint/prefer-literal-enum-member": "warn",
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/naming-convention": [
				"warn",
				{ selector: "default", format: ["camelCase"], leadingUnderscore: "allow" },
				{ selector: "variable", format: ["camelCase", "UPPER_CASE"], leadingUnderscore: "allow" },
				{ selector: "typeLike", format: ["PascalCase"] },
				{ selector: "enumMember", format: ["UPPER_CASE"] },
				{ selector: "objectLiteralProperty", format: null },
				{ selector: "import", format: ["camelCase", "PascalCase"], leadingUnderscore: "allow" },
			],

			// ⚠️ TypeScript - Less Strict (warnings)
			"@typescript-eslint/no-extraneous-class": "warn",
			"@typescript-eslint/no-empty-function": "warn",
			"@typescript-eslint/no-non-null-assertion": "warn",

			// 📋 ESLint - Code Quality
			"no-console": ["warn", { allow: ["warn", "error"] }],
			"no-debugger": "error",
			"no-var": "warn",
			"prefer-const": "warn",
			"prefer-arrow-callback": "warn",
			"no-nested-ternary": "warn",
			"no-multiple-empty-lines": ["warn", { max: 1 }],
			"eqeqeq": ["warn", "always"],
			"quotes": ["warn", "double", { avoidEscape: true }],
			"semi": ["warn", "always"],
			"comma-dangle": ["warn", "always-multiline"],
			"indent": ["warn", "tab"],
			"object-curly-spacing": ["warn", "always"],
			"no-empty": "off",
			"no-async-promise-executor": "off",
			"preserve-caught-error": "off",

			// 🚀 Custom Rules
			"custom/no-string-concat-prefer-template": "warn",
			"custom/no-deprecated-fns": "warn",
			"custom/no-json-stringify": "warn",
		},
		plugins: {
			custom: {
				...customPlugin,
			},
		},
		ignores: [
			"scripts/generateEmojiEnum.ts",
			"src/Cluster/Utils/generated/EmojiNames.ts",
		],
	},
]);
