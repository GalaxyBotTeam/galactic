// file: lib/rules/no-string-concat-prefer-template.js
module.exports = {
    meta: {
        type: "suggestion",
        docs: {
            description: "verhindert String-Konkatenation und erzwingt Template Literals",
            category: "ECMAScript 6",
            recommended: false,
        },
        fixable: "code",
        schema: [], // keine Optionen
        messages: {
            useTemplate: "Verwende Template Literals anstelle von String-Konkatenation.",
        },
    },

    create(context) {
        const sourceCode = context.sourceCode;

        function isStringLiteral(node) {
            return node && node.type === "Literal" && typeof node.value === "string";
        }

        function collectConcatParts(node) {
            const parts = [];

            function recurse(n) {
                if (n.type === "BinaryExpression" && n.operator === "+") {
                    recurse(n.left);
                    recurse(n.right);
                } else {
                    parts.push(n);
                }
            }

            recurse(node);
            return parts;
        }

        return {
            BinaryExpression(node) {
                if (node.operator !== "+") return;

                const parts = collectConcatParts(node);
                const hasString = parts.some(isStringLiteral);
                if (!hasString) return;

                context.report({
                    node,
                    messageId: "useTemplate",
                    fix(fixer) {
                        const raw = parts
                            .map(part => {
                                if (isStringLiteral(part)) {
                                    // Escape backticks and dollar signs
                                    return part.value
                                        .replace(/`/g, "\\`")
                                        .replace(/\$\{/g, "\\${");
                                } else {
                                    const text = sourceCode.getText(part);
                                    return `\${${text}}`;
                                }
                            })
                            .join("");

                        return fixer.replaceText(node, `\`${raw}\``);
                    },
                });
            },
        };
    },
};
