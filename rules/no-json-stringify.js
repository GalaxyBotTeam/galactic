module.exports = {
    meta: {
        type: "problem",
        docs: {
            description: "Verbietet JSON.stringify und ersetzt durch StringifyUtil.stringify aus '@galaxybotutils/core'",
            recommended: true
        },
        fixable: "code",
        messages: {
            avoidJsonStringify: "Verwende stattdessen StringifyUtil.stringify aus '@galaxybotutils/core'."
        },
        schema: []
    },

    create(context) {
        const sourceCode = context.sourceCode;
        let hasImport = false;

        return {
            Program(node) {
                const importDeclarations = node.body.filter(
                    (n) =>
                        (n.type === "ImportDeclaration" &&
                            n.source.value === "@galaxybotutils/core" &&
                            n.specifiers.some(
                                (s) =>
                                    s.type === "ImportSpecifier" &&
                                    s.imported.name === "StringifyUtil"
                            ))
                );

                if (importDeclarations.length > 0) {
                    hasImport = true;
                }
            },

            CallExpression(node) {
                if (
                    node.callee &&
                    node.callee.type === "MemberExpression" &&
                    node.callee.object.name === "JSON" &&
                    node.callee.property.name === "stringify"
                ) {
                    context.report({
                        node,
                        messageId: "avoidJsonStringify",
                        fix(fixer) {
                            const fixes = [];

                            // 1. Ersetze JSON.stringify(...) mit StringifyUtil.stringify(...)
                            const replacement = `StringifyUtil.stringify`;
                            fixes.push(
                                fixer.replaceText(node.callee, replacement)
                            );

                            // 2. Füge Import hinzu, falls nicht vorhanden
                            if (!hasImport) {
                                fixes.push(
                                    fixer.insertTextBeforeRange(
                                        [0, 0],
                                        `import { StringifyUtil } from '@galaxybotutils/core';\n`
                                    )
                                );
                                hasImport = true; // Damit es nur einmal eingefügt wird
                            }

                            return fixes;
                        }
                    });
                }
            }
        };
    }
};
