module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Verbietet Aufrufe veralteter Funktionen',
        },
        schema: [],
        messages: {
            deprecatedCall: "'{{name}}' ist veraltet und darf nicht verwendet werden.",
        },
    },
    create(context) {
        // Hier die Namen der veralteten Funktionen definieren
        const deprecatedFunctions = new Set(['alteFunktion', 'veralteteApi']);

        return {
            CallExpression(node) {
                if (node.callee.type === 'Identifier') {
                    const functionName = node.callee.name;
                    if (deprecatedFunctions.has(functionName)) {
                        context.report({
                            node,
                            messageId: 'deprecatedCall',
                            data: {
                                name: functionName,
                            },
                        });
                    }
                }
            },
        };
    },
};