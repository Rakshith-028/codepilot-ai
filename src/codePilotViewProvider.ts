import { RagService } from './ragService';
import * as vscode from 'vscode';

export class CodePilotViewProvider implements vscode.WebviewViewProvider {

    private view?: vscode.WebviewView;

    private latestDetectedError?: {
        error: string;
        line: number;
        code: string;
        uri: vscode.Uri;
        range: vscode.Range;
    };

    private latestProposedFix?: string;

    private latestProposedFixRange?: vscode.Range;
    private latestProposedFixUri?: vscode.Uri;
    private latestProposedOriginalText?: string;

    private latestFixAllRange?: vscode.Range;
    private latestFixAllUri?: vscode.Uri;
    private latestFixAllOriginalText?: string;
    private latestFixAllProposedText?: string;

    private conversationHistory: {
        role: 'user' | 'assistant';
        content: string;
    }[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly ragService: RagService
    ) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView
    ): void {

        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };


        // ==================================================
        // STREAM RESPONSE FROM OLLAMA
        // ==================================================

        const streamOllama = async (
            prompt: string,
            onChunk: (chunk: string) => void,
            maxTokens: number = 300
        ): Promise<string> => {

            const response = await fetch(
                'http://localhost:11434/api/generate',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json'
                    },

                    body: JSON.stringify({
                        model: 'qwen3:4b',

                        prompt,

                        stream: true,

                        think: false,

                        options: {
                            temperature: 0.2,
                            num_predict: maxTokens
                        }
                    })
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Ollama request failed: ${response.status}`
                );
            }

            if (!response.body) {
                throw new Error(
                    'Ollama returned no response body.'
                );
            }


            const reader =
                response.body.getReader();

            const decoder =
                new TextDecoder();

            let buffer = '';

            let completeText = '';


            while (true) {

                const {
                    done,
                    value
                } = await reader.read();


                if (done) {
                    break;
                }


                buffer += decoder.decode(
                    value,
                    {
                        stream: true
                    }
                );


                const lines =
                    buffer.split('\n');


                buffer =
                    lines.pop() ?? '';


                for (const line of lines) {

                    if (!line.trim()) {
                        continue;
                    }


                    try {

                        const data =
                            JSON.parse(line) as {
                                response?: string;
                                done?: boolean;
                            };


                        if (data.response) {

                            completeText +=
                                data.response;

                            onChunk(
                                data.response
                            );
                        }

                    } catch (error) {

                        console.error(
                            'Could not parse Ollama stream:',
                            error
                        );
                    }
                }
            }


            // Handle anything remaining in buffer

            if (buffer.trim()) {

                try {

                    const data =
                        JSON.parse(buffer) as {
                            response?: string;
                        };

                    if (data.response) {

                        completeText +=
                            data.response;

                        onChunk(
                            data.response
                        );
                    }

                } catch {
                    // Ignore incomplete trailing JSON
                }
            }


            return completeText;
        };

        // ==================================================
        // CURRENT FUNCTION / SYMBOL CONTEXT
        // ==================================================

        const getCurrentSymbolContext = async (
            document: vscode.TextDocument,
            position: vscode.Position
        ): Promise<string> => {

            try {

                const symbols =
                    await vscode.commands.executeCommand<
                        (vscode.DocumentSymbol | vscode.SymbolInformation)[]
                    >(
                        'vscode.executeDocumentSymbolProvider',
                        document.uri
                    );

                if (!symbols || symbols.length === 0) {
                    return '';
                }

                let bestSymbol:
                    vscode.DocumentSymbol | undefined;

                const allowedKinds = new Set([
                    vscode.SymbolKind.Function,
                    vscode.SymbolKind.Method,
                    vscode.SymbolKind.Constructor
                ]);

                const visitSymbols = (
                    items: vscode.DocumentSymbol[]
                ) => {

                    for (const symbol of items) {

                        if (
                            symbol.range.contains(position)
                        ) {

                            if (
                                allowedKinds.has(
                                    symbol.kind
                                )
                            ) {

                                if (
                                    !bestSymbol ||
                                    symbol.range.start.line >=
                                    bestSymbol.range.start.line
                                ) {

                                    bestSymbol = symbol;
                                }
                            }

                            if (
                                symbol.children &&
                                symbol.children.length > 0
                            ) {

                                visitSymbols(
                                    symbol.children
                                );
                            }
                        }
                    }
                };

                const documentSymbols =
                    symbols.filter(
                        (
                            symbol
                        ): symbol is vscode.DocumentSymbol =>
                            'range' in symbol
                    );

                visitSymbols(documentSymbols);

                if (!bestSymbol) {
                    return '';
                }

                const selectedSymbol =
                    bestSymbol as vscode.DocumentSymbol;

                const symbolCode =
                    document.getText(
                        selectedSymbol.range
                    );

                return `
CURRENT FUNCTION / METHOD:
${selectedSymbol.name}

EXACT FUNCTION CODE:
${symbolCode}
`;

            } catch (error) {

                console.error(
                    'CodePilot symbol detection error:',
                    error
                );

                return '';
            }
        };

        // ==================================================
        // MESSAGES FROM SIDEBAR
        // ==================================================

        webviewView.webview.onDidReceiveMessage(
            async (message) => {


                if (message.command === 'indexProject') {

                    webviewView.webview.postMessage({
                        command: 'ragStatus',
                        text: 'Indexing project...'
                    });

                    try {

                        const fileCount =
                            await this.ragService.indexWorkspace();

                        webviewView.webview.postMessage({
                            command: 'ragStatus',
                            text: `✅ Indexed ${fileCount} project files`
                        });

                    } catch (error) {

                        console.error(
                            'CodePilot RAG indexing error:',
                            error
                        );

                        webviewView.webview.postMessage({
                            command: 'ragStatus',
                            text: '❌ Could not index project'
                        });
                    }
                }

                if (message.command === 'openSourceFile') {

                    const source =
                        typeof message.source === 'string'
                            ? message.source
                            : '';

                    if (!source) {
                        return;
                    }

                    const workspaceFolder =
                        vscode.workspace.workspaceFolders?.[0];

                    if (!workspaceFolder) {
                        return;
                    }

                    try {

                        const fileUri =
                            vscode.Uri.joinPath(
                                workspaceFolder.uri,
                                source
                            );

                        const document =
                            await vscode.workspace.openTextDocument(
                                fileUri
                            );

                        await vscode.window.showTextDocument(
                            document
                        );

                    } catch (error) {

                        console.error(
                            'CodePilot could not open source file:',
                            error
                        );

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: `Could not open ${source}.`
                        });
                    }
                }

                // ==================================================
                // ASK AI
                // ==================================================

                if (message.command === 'askAI') {

                    const mode =
                        message.mode ?? 'normal';

                    let maxTokens = 350;

                    if (mode === 'fast') {
                        maxTokens = 320;
                    }

                    if (mode === 'detailed') {
                        maxTokens = 700;
                    }

                    webviewView.webview.postMessage({
                        command: 'streamStart'
                    });

                    try {

                        let projectContext = '';
                        let currentFileContext = '';

                        const editor =
                            vscode.window.activeTextEditor;

                        if (editor) {

                            const document =
                                editor.document;

                            const cursorLine =
                                editor.selection.active.line;

                            const startLine =
                                Math.max(
                                    0,
                                    cursorLine - 5
                                );

                            const endLine =
                                Math.min(
                                    document.lineCount - 1,
                                    cursorLine + 20
                                );

                            const range =
                                new vscode.Range(
                                    startLine,
                                    0,
                                    endLine,
                                    document.lineAt(endLine).text.length
                                );

                            const nearbyCode =
                                document.getText(range);

                            const currentLineCode =
                                document.lineAt(
                                    cursorLine
                                ).text;
                            const symbolContext =
                                await getCurrentSymbolContext(
                                    document,
                                    editor.selection.active
                                );

                            const fileName =
                                vscode.workspace.asRelativePath(
                                    document.uri
                                );

                            currentFileContext = `
CURRENT OPEN FILE:
${fileName}

CURSOR LINE NUMBER:
${cursorLine + 1}

EXACT CODE ON CURSOR LINE:
${currentLineCode}

${symbolContext || `
NO EXACT FUNCTION SYMBOL WAS DETECTED.

FALLBACK CODE AROUND CURSOR:
${nearbyCode}
`}

IMPORTANT:
If CURRENT FUNCTION / METHOD is available, treat it as the primary code
the user is referring to when they say "this function", "this code",
"here", or similar.

Only use FALLBACK CODE AROUND CURSOR when an exact function symbol
could not be detected.
`;
                        }

                        if (this.ragService.isProjectIndexed()) {

                            webviewView.webview.postMessage({
                                command: 'ragStatus',
                                text: '🔎 Searching project context...'
                            });

                            projectContext =
                                await this.ragService.searchProject(
                                    message.text,
                                    4
                                );

                            const sources =
                                [
                                    ...new Set(
                                        projectContext
                                            .split('\n')
                                            .filter(line =>
                                                line.trim().startsWith('File:')
                                            )
                                            .map(line =>
                                                line
                                                    .replace('File:', '')
                                                    .trim()
                                            )
                                    )
                                ];

                            webviewView.webview.postMessage({
                                command: 'ragSources',
                                sources
                            });

                            webviewView.webview.postMessage({
                                command: 'ragStatus',
                                text: '✅ Project context loaded'
                            });
                        }

                        const recentHistory =
                            this.conversationHistory
                                .slice(-6)
                                .map(
                                    item =>
                                        `${item.role.toUpperCase()}: ${item.content}`
                                )
                                .join('\n\n');

                        const response = await fetch(
                            'http://localhost:11434/api/generate',
                            {
                                method: 'POST',

                                headers: {
                                    'Content-Type': 'application/json'
                                },

                                body: JSON.stringify({
                                    model: 'qwen3:4b',

                                    prompt: `
You are CodePilot AI.

CURRENT FILE CONTEXT:
${currentFileContext || 'No active file context available.'}

PROJECT CONTEXT:
${projectContext || 'No project context available.'}

CONVERSATION HISTORY:
${recentHistory || 'No previous conversation.'}

USER QUESTION:
${message.text}

Answer the user's question directly and use the retrieved context to provide a concrete answer, not an echo of the question.

Rules:
- Prefer CURRENT FILE CONTEXT when the user says things like "this", "this function", "here", or refers to the current code.
- Use PROJECT CONTEXT when information from other project files is needed.
- Use CONVERSATION HISTORY to understand follow-up questions such as "optimize it", "explain that", or "fix this".
- Prefer the newest relevant context when history and current file context differ.
- Mention the exact file name when possible.
- If the question asks "which file", "where", or "kis file me", answer with the most likely file first, then one short reason.
- Do not simply repeat or paraphrase the user's question.
- Do not answer with only the question text.
- Do not invent files, functions, or code.
- Do not explain your internal reasoning.
- Keep the answer practical and concise.
- Even in Fast mode, return at least one complete useful sentence.

                    `,

                                    stream: false,

                                    think: false,

                                    format: {
                                        type: 'object',

                                        properties: {
                                            answer: {
                                                type: 'string'
                                            }
                                        },

                                        required: ['answer']
                                    },

                                    options: {
                                        temperature: 0.1,
                                        num_predict: maxTokens
                                    }
                                })
                            }
                        );

                        if (!response.ok) {
                            throw new Error(
                                `Ollama request failed: ${response.status}`
                            );
                        }

                        const data = await response.json() as {
                            response: string;
                        };

                        const parsed =
                            JSON.parse(data.response) as {
                                answer: string;
                            };

                        const answer =
                            parsed.answer.trim();

                        this.conversationHistory.push({
                            role: 'user',
                            content: message.text
                        });

                        this.conversationHistory.push({
                            role: 'assistant',
                            content: answer
                        });

                        if (
                            this.conversationHistory.length > 12
                        ) {
                            this.conversationHistory =
                                this.conversationHistory.slice(-12);
                        }

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: answer
                        });

                    } catch (error) {

                        console.error(
                            'CodePilot Ask AI error:',
                            error
                        );

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'Could not answer the question.'
                        });
                    }
                }

                // ==================================================
                // SELECTED CODE ACTIONS
                // ==================================================

                if (
                    message.command === 'explainSelectedCode' ||
                    message.command === 'fixError' ||
                    message.command === 'improveCode'
                ) {

                    const editor =
                        vscode.window.activeTextEditor;


                    if (!editor) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No active editor found.'
                        });

                        return;
                    }


                    const selectedCode =
                        editor.document.getText(
                            editor.selection
                        );


                    if (!selectedCode.trim()) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'Please select some code first.'
                        });

                        return;
                    }


                    let prompt = '';

                    let maxTokens = 250;


                    // --------------------------------
                    // EXPLAIN SELECTED CODE
                    // --------------------------------

                    if (
                        message.command ===
                        'explainSelectedCode'
                    ) {

                        prompt = `
You are a coding tutor.

Explain this code concisely.

Give only:

1. What it does
2. Main concept
3. Any important issue

Do not over-explain.

Code:

${selectedCode}
                        `;

                        maxTokens = 220;
                    }


                    // --------------------------------
                    // FIX SELECTED CODE
                    // --------------------------------

                    if (
                        message.command ===
                        'fixError'
                    ) {

                        prompt = `
You are a debugging assistant.

Analyze this code.

Give only:

1. Error
2. Cause
3. Corrected code
4. One short tip

Keep the response concise.

Code:

${selectedCode}
                        `;

                        maxTokens = 250;
                    }


                    // --------------------------------
                    // IMPROVE CODE
                    // --------------------------------

                    if (
                        message.command ===
                        'improveCode'
                    ) {

                        prompt = `
You are a senior software engineer.

Review this code.

Give only:

1. Main weaknesses
2. Improved code
3. Short explanation

Avoid unnecessary detail.

Code:

${selectedCode}
                        `;

                        maxTokens = 300;
                    }


                    webviewView.webview.postMessage({
                        command: 'streamStart'
                    });


                    try {

                        await streamOllama(
                            prompt,

                            chunk => {

                                webviewView.webview.postMessage({
                                    command: 'streamChunk',
                                    text: chunk
                                });

                            },

                            maxTokens
                        );


                    } catch (error) {

                        console.error(error);

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'Could not connect to Ollama.'
                        });
                    }
                }


                // ==================================================
                // EXPLAIN DETECTED ERROR
                // ==================================================

                if (
                    message.command ===
                    'explainDetectedError'
                ) {

                    if (!this.latestDetectedError) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No detected error available.'
                        });

                        return;
                    }


                    const {
                        error,
                        line,
                        code
                    } = this.latestDetectedError;


                    webviewView.webview.postMessage({
                        command: 'streamStart'
                    });


                    try {

                        await streamOllama(
                            `
You are a coding debugger.

VS Code detected:

Error:
${error}

Line:
${line}

Code:
${code}

Explain ONLY:

1. Problem
2. Why it happened
3. Corrected code
4. One short learning tip

Be concise.
                            `,

                            chunk => {

                                webviewView.webview.postMessage({
                                    command: 'streamChunk',
                                    text: chunk
                                });

                            },

                            220
                        );


                    } catch (error) {

                        console.error(error);

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'Could not connect to Ollama.'
                        });
                    }
                }


                // ==================================================
                // GENERATE FIX
                // ==================================================

                if (
                    message.command ===
                    'generateFix'
                ) {

                    if (!this.latestDetectedError) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No detected error available.'
                        });

                        return;
                    }


                    const {
                        error,
                        code,
                        uri,
                        range
                    } = this.latestDetectedError;

                    const document =
                        await vscode.workspace.openTextDocument(uri);

                    const errorPosition =
                        range.start;

                    const errorLine =
                        errorPosition.line;

                    // --------------------------------------------------
                    // DETERMINISTIC SINGLE-FIX FOR EXPLICIT MISSING BRACE
                    // --------------------------------------------------
                    // For an explicit "'}' expected" diagnostic, use a minimal
                    // insertion edit instead of replacing an entire function.
                    // This prevents unrelated code (for example the next function
                    // declaration) from being rewritten or corrupted.
                    if (/['"]?}['"]?\s*expected/i.test(error)) {

                        const braceStack: {
                            line: number;
                            character: number;
                        }[] = [];

                        let inSingleQuote = false;
                        let inDoubleQuote = false;
                        let inTemplate = false;
                        let inBlockComment = false;
                        let escaped = false;

                        for (
                            let lineIndex = 0;
                            lineIndex <= Math.min(
                                errorLine,
                                document.lineCount - 1
                            );
                            lineIndex++
                        ) {

                            const lineText =
                                document.lineAt(lineIndex).text;

                            let inLineComment = false;

                            for (
                                let characterIndex = 0;
                                characterIndex < lineText.length;
                                characterIndex++
                            ) {

                                const character =
                                    lineText[characterIndex];

                                const nextCharacter =
                                    lineText[characterIndex + 1] ?? '';

                                if (inLineComment) {
                                    break;
                                }

                                if (inBlockComment) {

                                    if (
                                        character === '*' &&
                                        nextCharacter === '/'
                                    ) {
                                        inBlockComment = false;
                                        characterIndex++;
                                    }

                                    continue;
                                }

                                if (escaped) {
                                    escaped = false;
                                    continue;
                                }

                                if (inSingleQuote) {

                                    if (character === '\\') {
                                        escaped = true;
                                    } else if (character === "'") {
                                        inSingleQuote = false;
                                    }

                                    continue;
                                }

                                if (inDoubleQuote) {

                                    if (character === '\\') {
                                        escaped = true;
                                    } else if (character === '"') {
                                        inDoubleQuote = false;
                                    }

                                    continue;
                                }

                                if (inTemplate) {

                                    if (character === '\\') {
                                        escaped = true;
                                    } else if (character === '`') {
                                        inTemplate = false;
                                    }

                                    continue;
                                }

                                if (
                                    character === '/' &&
                                    nextCharacter === '/'
                                ) {
                                    inLineComment = true;
                                    break;
                                }

                                if (
                                    character === '/' &&
                                    nextCharacter === '*'
                                ) {
                                    inBlockComment = true;
                                    characterIndex++;
                                    continue;
                                }

                                if (character === "'") {
                                    inSingleQuote = true;
                                    continue;
                                }

                                if (character === '"') {
                                    inDoubleQuote = true;
                                    continue;
                                }

                                if (character === '`') {
                                    inTemplate = true;
                                    continue;
                                }

                                if (character === '{') {

                                    braceStack.push({
                                        line: lineIndex,
                                        character: characterIndex
                                    });

                                    continue;
                                }

                                if (character === '}') {

                                    if (braceStack.length > 0) {
                                        braceStack.pop();
                                    }
                                }
                            }
                        }

                        const unmatchedBrace =
                            braceStack[braceStack.length - 1];

                        if (unmatchedBrace) {

                            const openerLineText =
                                document.lineAt(
                                    unmatchedBrace.line
                                ).text;

                            const openerIndentation =
                                openerLineText.match(/^\s*/)?.[0] ?? '';

                            const indentationWidth = (
                                value: string
                            ): number =>
                                value
                                    .replace(/\t/g, '    ')
                                    .length;

                            const openerIndentWidth =
                                indentationWidth(
                                    openerIndentation
                                );

                            let insertionLine =
                                Math.min(
                                    errorLine,
                                    document.lineCount - 1
                                );

                            const siblingDeclaration =
                                /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\b/;

                            /*
                             * With a missing closing brace, the parser may treat
                             * the following top-level function as nested. Find the
                             * first later function/class whose visual indentation
                             * is at the same level (or less) as the unmatched
                             * opener and close the earlier construct immediately
                             * before it.
                             */
                            for (
                                let lineIndex =
                                    unmatchedBrace.line + 1;
                                lineIndex <=
                                    Math.min(
                                        errorLine,
                                        document.lineCount - 1
                                    );
                                lineIndex++
                            ) {

                                const candidateLine =
                                    document.lineAt(
                                        lineIndex
                                    ).text;

                                const trimmed =
                                    candidateLine.trimStart();

                                if (!trimmed) {
                                    continue;
                                }

                                const candidateIndentation =
                                    candidateLine.match(/^\s*/)?.[0] ?? '';

                                if (
                                    siblingDeclaration.test(
                                        trimmed
                                    ) &&
                                    indentationWidth(
                                        candidateIndentation
                                    ) <= openerIndentWidth
                                ) {
                                    insertionLine =
                                        lineIndex;
                                    break;
                                }
                            }

                            const insertionPosition =
                                new vscode.Position(
                                    insertionLine,
                                    0
                                );

                            const insertionRange =
                                new vscode.Range(
                                    insertionPosition,
                                    insertionPosition
                                );

                            const insertionText =
                                openerIndentation +
                                '}' +
                                '\n';

                            this.latestProposedFixRange =
                                insertionRange;

                            this.latestProposedFixUri =
                                uri;

                            /*
                             * An insertion range contains no original text.
                             * Keep the empty string so stale-code protection can
                             * still compare the exact range before applying.
                             */
                            this.latestProposedOriginalText =
                                '';

                            this.latestProposedFix =
                                insertionText;

                            webviewView.webview.postMessage({
                                command: 'fixReady',
                                text: insertionText
                            });

                            return;
                        }
                    }

                    // Default safest target:
                    // replace only the exact diagnostic line.
                    let repairRange =
                        document.lineAt(
                            errorLine
                        ).range;

                    let repairTargetType =
                        'single line';


                    // Try to find the smallest function/method/constructor
                    // that actually contains the diagnostic position.
                    // If symbol detection fails because the syntax is broken,
                    // CodePilot safely falls back to the error line only.
                    try {

                        const symbols =
                            await vscode.commands.executeCommand<
                                (
                                    vscode.DocumentSymbol |
                                    vscode.SymbolInformation
                                )[]
                            >(
                                'vscode.executeDocumentSymbolProvider',
                                uri
                            );

                        if (symbols) {

                            const allowedKinds =
                                new Set([
                                    vscode.SymbolKind.Function,
                                    vscode.SymbolKind.Method,
                                    vscode.SymbolKind.Constructor
                                ]);

                            let bestSymbol:
                                vscode.DocumentSymbol |
                                undefined;

                            const visitSymbols = (
                                items: vscode.DocumentSymbol[]
                            ) => {

                                for (const symbol of items) {

                                    if (
                                        symbol.range.contains(
                                            errorPosition
                                        )
                                    ) {

                                        if (
                                            allowedKinds.has(
                                                symbol.kind
                                            )
                                        ) {

                                            if (
                                                !bestSymbol ||
                                                (
                                                    symbol.range.end.line -
                                                    symbol.range.start.line
                                                ) <
                                                (
                                                    bestSymbol.range.end.line -
                                                    bestSymbol.range.start.line
                                                )
                                            ) {

                                                bestSymbol =
                                                    symbol;
                                            }
                                        }

                                        if (
                                            symbol.children &&
                                            symbol.children.length > 0
                                        ) {

                                            visitSymbols(
                                                symbol.children
                                            );
                                        }
                                    }
                                }
                            };

                            const documentSymbols =
                                symbols.filter(
                                    (
                                        symbol
                                    ): symbol is vscode.DocumentSymbol =>
                                        'range' in symbol
                                );

                            visitSymbols(
                                documentSymbols
                            );

                            if (bestSymbol) {

                                repairRange =
                                    bestSymbol.range;

                                repairTargetType =
                                    'function or method';
                            }
                        }

                    } catch (symbolError) {

                        console.error(
                            'CodePilot repair-range symbol detection failed:',
                            symbolError
                        );
                    }


                    const repairCode =
                        document.getText(
                            repairRange
                        );


                    this.latestProposedFix =
                        undefined;

                    this.latestProposedFixRange =
                        undefined;

                    this.latestProposedFixUri =
                        undefined;

                    this.latestProposedOriginalText =
                        undefined;


                    webviewView.webview.postMessage({
                        command: 'fixStreamStart'
                    });


                    try {

                        const response = await fetch(
                            'http://localhost:11434/api/generate',
                            {
                                method: 'POST',

                                headers: {
                                    'Content-Type': 'application/json'
                                },

                                body: JSON.stringify({
                                    model: 'qwen3:4b',

                                    prompt: `
You are CodePilot AI, a precise debugging assistant.

VS Code reported this diagnostic:

${error}

Diagnostic line:
${code}

TARGET TYPE:
${repairTargetType}

TARGET CODE TO REPLACE:

${repairCode}

Return the corrected version of TARGET CODE TO REPLACE.

Rules:
- Fix only what is necessary to resolve the diagnostic.
- Preserve the user's original logic.
- Preserve unrelated code inside the target.
- Do not add code from outside the target.
- Do not remove braces or statements unless they are part of the actual fix.
- If TARGET TYPE is "single line", return exactly one corrected line.
- If TARGET TYPE is "function or method", return the complete corrected function/method.
- Do not add explanations.
- Do not use markdown code fences.
- Return only the corrected target inside the JSON field "fix".
`,

                                    stream: false,

                                    think: false,

                                    format: {
                                        type: 'object',

                                        properties: {
                                            fix: {
                                                type: 'string'
                                            }
                                        },

                                        required: ['fix']
                                    },

                                    options: {
                                        temperature: 0,
                                        num_predict: 350
                                    }
                                })
                            }
                        );


                        if (!response.ok) {

                            throw new Error(
                                `Ollama request failed: ${response.status}`
                            );
                        }


                        const data =
                            await response.json() as {
                                response: string;
                            };


                        const parsed =
                            JSON.parse(
                                data.response
                            ) as {
                                fix: string;
                            };


                        // Ollama may sometimes return escaped line breaks
                        // as literal "\n" text. Convert those before validation.
                        let cleanFix =
                            parsed.fix
                                .replace(/\\r\\n/g, '\n')
                                .replace(/\\n/g, '\n')
                                .trimEnd();


                        if (!cleanFix.trim()) {

                            this.latestProposedFix =
                                undefined;

                            this.latestProposedFixRange =
                                undefined;

                            this.latestProposedFixUri =
                                undefined;

                            this.latestProposedOriginalText =
                                undefined;

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '⚠️ AI did not return a valid fix.'
                            });

                            return;
                        }


                        if (cleanFix === repairCode) {

                            this.latestProposedFix =
                                undefined;

                            this.latestProposedFixRange =
                                undefined;

                            this.latestProposedFixUri =
                                undefined;

                            this.latestProposedOriginalText =
                                undefined;

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '⚠️ AI returned the same code, so CodePilot blocked a no-op fix.'
                            });

                            return;
                        }


                        // Extra safety:
                        // a single-line repair must remain single-line.
                        if (
                            repairTargetType ===
                            'single line' &&
                            cleanFix.includes('\n')
                        ) {

                            this.latestProposedFix =
                                undefined;

                            this.latestProposedFixRange =
                                undefined;

                            this.latestProposedFixUri =
                                undefined;

                            this.latestProposedOriginalText =
                                undefined;

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '⚠️ AI returned a multi-line change for a single-line error, so CodePilot blocked it.'
                            });

                            return;
                        }


                        this.latestProposedFixRange =
                            repairRange;

                        this.latestProposedFixUri =
                            uri;

                        this.latestProposedOriginalText =
                            repairCode;

                        this.latestProposedFix =
                            cleanFix;


                        webviewView.webview.postMessage({
                            command: 'fixReady',
                            text: cleanFix
                        });


                    } catch (generateError) {

                        console.error(
                            'CodePilot Generate Fix Error:',
                            generateError
                        );

                        this.latestProposedFix =
                            undefined;

                        this.latestProposedFixRange =
                            undefined;

                        this.latestProposedFixUri =
                            undefined;

                        this.latestProposedOriginalText =
                            undefined;

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'Could not generate a safe fix.'
                        });
                    }
                }


                // ==================================================
                // FIX ALL ERRORS IN ACTIVE FILE - PREVIEW ONLY
                // ==================================================

                if (
                    message.command ===
                    'fixAllErrors'
                ) {

                    const editor =
                        vscode.window.activeTextEditor;

                    if (!editor) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No active editor found.'
                        });

                        return;
                    }

                    const targetUri =
                        editor.document.uri;

                    const document =
                        editor.document;

                    const diagnostics =
                        vscode.languages
                            .getDiagnostics(
                                targetUri
                            )
                            .filter(
                                diagnostic =>
                                    diagnostic.severity ===
                                    vscode.DiagnosticSeverity.Error
                            );

                    if (diagnostics.length === 0) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: '✅ No errors found in the active file.'
                        });

                        return;
                    }

                    // Clear old single-fix preview/state so the user
                    // cannot accidentally apply an unrelated stale fix.
                    this.latestProposedFix =
                        undefined;

                    this.latestProposedFixRange =
                        undefined;

                    this.latestProposedFixUri =
                        undefined;

                    this.latestProposedOriginalText =
                        undefined;

                    webviewView.webview.postMessage({
                        command: 'clearSingleFixPreview'
                    });

                    try {

                        const firstErrorLine =
                            Math.min(
                                ...diagnostics.map(
                                    diagnostic =>
                                        diagnostic.range.start.line
                                )
                            );

                        const lastErrorLine =
                            Math.max(
                                ...diagnostics.map(
                                    diagnostic =>
                                        diagnostic.range.end.line
                                )
                            );

                        // --------------------------------------------------
                        // STRUCTURAL CONTEXT FOR HIDDEN MISSING CLOSERS
                        // --------------------------------------------------
                        // A parser often reports a missing closing brace at the
                        // END of the file even though the matching opening brace
                        // is much higher up. If Fix All only sends 20 lines around
                        // the diagnostic, the model never sees the real opening
                        // token and can place the closer in the wrong location.
                        //
                        // Scan the document up to the last diagnostic and locate
                        // the most recent unmatched opening token that corresponds
                        // to an explicit "expected" diagnostic. Strings/comments
                        // are ignored so braces inside text do not confuse the scan.
                        const findStructuralOpeningLine = (): number | undefined => {

                            const neededOpeners =
                                new Set<string>();

                            for (const diagnostic of diagnostics) {

                                const message =
                                    diagnostic.message;

                                if (/['"]?}['"]?\s*expected/i.test(message)) {
                                    neededOpeners.add('{');
                                }

                                if (/['"]?\)['"]?\s*expected/i.test(message)) {
                                    neededOpeners.add('(');
                                }

                                if (/['"]?\]['"]?\s*expected/i.test(message)) {
                                    neededOpeners.add('[');
                                }
                            }

                            if (neededOpeners.size === 0) {
                                return undefined;
                            }

                            const stacks: Record<string, number[]> = {
                                '{': [],
                                '(': [],
                                '[': []
                            };

                            let inSingleQuote = false;
                            let inDoubleQuote = false;
                            let inTemplate = false;
                            let inBlockComment = false;
                            let escaped = false;

                            const maxLine =
                                Math.min(
                                    lastErrorLine,
                                    document.lineCount - 1
                                );

                            for (let lineIndex = 0; lineIndex <= maxLine; lineIndex++) {

                                const line =
                                    document.lineAt(lineIndex).text;

                                let inLineComment = false;

                                for (let characterIndex = 0; characterIndex < line.length; characterIndex++) {

                                    const character =
                                        line[characterIndex];

                                    const nextCharacter =
                                        line[characterIndex + 1] ?? '';

                                    if (inLineComment) {
                                        break;
                                    }

                                    if (inBlockComment) {
                                        if (character === '*' && nextCharacter === '/') {
                                            inBlockComment = false;
                                            characterIndex++;
                                        }
                                        continue;
                                    }

                                    if (escaped) {
                                        escaped = false;
                                        continue;
                                    }

                                    if (inSingleQuote) {
                                        if (character === '\\') {
                                            escaped = true;
                                        } else if (character === "'") {
                                            inSingleQuote = false;
                                        }
                                        continue;
                                    }

                                    if (inDoubleQuote) {
                                        if (character === '\\') {
                                            escaped = true;
                                        } else if (character === '"') {
                                            inDoubleQuote = false;
                                        }
                                        continue;
                                    }

                                    if (inTemplate) {
                                        if (character === '\\') {
                                            escaped = true;
                                        } else if (character === '`') {
                                            inTemplate = false;
                                        }
                                        continue;
                                    }

                                    if (character === '/' && nextCharacter === '/') {
                                        inLineComment = true;
                                        break;
                                    }

                                    if (character === '/' && nextCharacter === '*') {
                                        inBlockComment = true;
                                        characterIndex++;
                                        continue;
                                    }

                                    if (character === "'") {
                                        inSingleQuote = true;
                                        continue;
                                    }

                                    if (character === '"') {
                                        inDoubleQuote = true;
                                        continue;
                                    }

                                    if (character === '`') {
                                        inTemplate = true;
                                        continue;
                                    }

                                    if (character === '{' || character === '(' || character === '[') {
                                        stacks[character].push(lineIndex);
                                        continue;
                                    }

                                    if (character === '}') {
                                        stacks['{'].pop();
                                        continue;
                                    }

                                    if (character === ')') {
                                        stacks['('].pop();
                                        continue;
                                    }

                                    if (character === ']') {
                                        stacks['['].pop();
                                    }
                                }
                            }

                            const candidates: number[] = [];

                            for (const opener of neededOpeners) {

                                const stack =
                                    stacks[opener];

                                if (stack.length > 0) {
                                    candidates.push(
                                        stack[stack.length - 1]
                                    );
                                }
                            }

                            if (candidates.length === 0) {
                                return undefined;
                            }

                            return Math.min(...candidates);
                        };

                        const structuralOpeningLine =
                            findStructuralOpeningLine();

                        // Small files can still be analyzed as a whole. For larger
                        // files, start from the actual unmatched opening token when
                        // one is found; otherwise fall back to the diagnostic window.
                        const useWholeFile =
                            document.lineCount <= 120;

                        const defaultStartLine =
                            Math.max(
                                0,
                                firstErrorLine - 20
                            );

                        const startLine =
                            useWholeFile
                                ? 0
                                : structuralOpeningLine !== undefined
                                    ? Math.max(
                                        0,
                                        Math.min(
                                            defaultStartLine,
                                            structuralOpeningLine - 2
                                        )
                                    )
                                    : defaultStartLine;

                        const endLine =
                            useWholeFile
                                ? document.lineCount - 1
                                : Math.min(
                                    document.lineCount - 1,
                                    lastErrorLine + 20
                                );

                        const combinedRange =
                            new vscode.Range(
                                startLine,
                                0,
                                endLine,
                                document.lineAt(
                                    endLine
                                ).text.length
                            );

                        const originalBlock =
                            document.getText(
                                combinedRange
                            );

                        const diagnosticText =
                            diagnostics
                                .map(
                                    (
                                        diagnostic,
                                        index
                                    ) => {

                                        return `${index + 1}. Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
                                    }
                                )
                                .join('\n');


                        const structuralHints =
                            diagnostics
                                .map(diagnostic => {

                                    const message =
                                        diagnostic.message;

                                    if (/['"]?}['"]?\s*expected/i.test(message)) {
                                        return '- MANDATORY: a closing } is expected. Add the missing closing brace at the structurally correct location.';
                                    }

                                    if (/['"]?\)['"]?\s*expected/i.test(message)) {
                                        return '- MANDATORY: a closing ) is expected. Add the missing closing parenthesis at the structurally correct location.';
                                    }

                                    if (/['"]?\]['"]?\s*expected/i.test(message)) {
                                        return '- MANDATORY: a closing ] is expected. Add the missing closing bracket at the structurally correct location.';
                                    }

                                    if (/['"]?;['"]?\s*expected/i.test(message)) {
                                        return '- MANDATORY: a semicolon is expected. Add it where required without changing unrelated logic.';
                                    }

                                    return '';
                                })
                                .filter(Boolean)
                                .join('\n');

                        const response =
                            await fetch(
                                'http://localhost:11434/api/generate',
                                {
                                    method: 'POST',

                                    headers: {
                                        'Content-Type':
                                            'application/json'
                                    },

                                    body:
                                        JSON.stringify({
                                            model:
                                                'qwen3:4b',

                                            prompt: `
You are CodePilot AI, a precise debugging assistant.

The active file has these VS Code diagnostics:

${diagnosticText}

MANDATORY STRUCTURAL REQUIREMENTS:
${structuralHints || '- Resolve every listed diagnostic and verify delimiter balance.'}

STRUCTURAL ANCHOR:
${structuralOpeningLine !== undefined
    ? `An unmatched opening delimiter was detected near original file line ${structuralOpeningLine + 1}. Inspect from that opening construct and place the missing closer where that construct should actually end.`
    : 'No reliable unmatched opening delimiter was found; use the supplied code structure and diagnostics.'}

CODE BLOCK CONTAINING THE ERROR CLUSTER:

${originalBlock}

Return the corrected version of the ENTIRE CODE BLOCK above.

Important:
- EVERY listed diagnostic must be addressed in the returned code.
- If a diagnostic explicitly says a token such as }, ), ], or ; is expected, the corrected code MUST contain that missing token at the structurally correct location.
- Fix the root syntax/programming mistakes that cause these diagnostics.
- Do NOT limit yourself only to the diagnostics currently reported by VS Code.
- One syntax error may hide another until the first error is corrected.
- Inspect the supplied block for directly related syntax problems.
- Explicitly check matching (), {}, and [] pairs.
- Check missing/extra semicolons, commas, quotes, parentheses, braces, and brackets.
- Check malformed if/for/while/function declarations and incomplete statements.
- If the block includes the end of a function/class/file, verify that opened blocks are properly closed.
- Some diagnostics may be cascading errors caused by one earlier mistake.
- Preserve all unrelated valid code in this block.
- Preserve the user's original logic.
- Do not remove valid braces, functions, statements, or lines.
- Do not add unrelated functionality.
- Keep the same overall structure unless a change is required to make the code valid.
- Return the COMPLETE corrected block, not only the changed lines.
- Before answering, silently re-check the corrected block for unmatched delimiters.
- Do not add explanations.
- Do not use markdown code fences.
- Return only the corrected block inside the JSON field "fix".
`,

                                            stream: false,

                                            think: false,

                                            format: {
                                                type:
                                                    'object',

                                                properties: {
                                                    fix: {
                                                        type:
                                                            'string'
                                                    }
                                                },

                                                required: [
                                                    'fix'
                                                ]
                                            },

                                            options: {
                                                temperature:
                                                    0,

                                                num_predict:
                                                    1000
                                            }
                                        })
                                }
                            );

                        if (!response.ok) {

                            throw new Error(
                                `Ollama request failed: ${response.status}`
                            );
                        }

                        const data =
                            await response.json() as {
                                response: string;
                            };

                        const parsed =
                            JSON.parse(
                                data.response
                            ) as {
                                fix: string;
                            };

                        let cleanFix =
                            parsed.fix
                                .replace(/\\r\\n/g, '\n')
                                .replace(/\\n/g, '\n')
                                .trimEnd();

                        if (!cleanFix.trim()) {

                            throw new Error(
                                'AI returned an empty Fix All preview.'
                            );
                        }

                        const hasStructuralDiagnostic =
                            diagnostics.some(
                                diagnostic =>
                                    /expected|unterminated|unmatched|unexpected end/i.test(
                                        diagnostic.message
                                    )
                            );

                        if (hasStructuralDiagnostic) {

                            const verificationResponse =
                                await fetch(
                                    'http://localhost:11434/api/generate',
                                    {
                                        method: 'POST',

                                        headers: {
                                            'Content-Type':
                                                'application/json'
                                        },

                                        body:
                                            JSON.stringify({
                                                model:
                                                    'qwen3:4b',

                                                prompt: `
You are the final syntax verifier for CodePilot AI.

ORIGINAL VS CODE DIAGNOSTICS:
${diagnosticText}

MANDATORY STRUCTURAL REQUIREMENTS:
${structuralHints || '- Resolve every listed syntax diagnostic.'}

STRUCTURAL ANCHOR:
${structuralOpeningLine !== undefined
    ? `The original source has an unmatched opening delimiter near file line ${structuralOpeningLine + 1}. Make sure the candidate closes that specific construct at its natural boundary, not merely at the diagnostic line.`
    : 'Use the candidate structure and diagnostics to place missing closers correctly.'}

CANDIDATE FIX:
${cleanFix}

Return a final corrected version of the COMPLETE candidate block.

Rules:
- Do not merely review it; CORRECT it if any listed diagnostic is still not addressed.
- Treat messages such as "'}' expected", "')' expected", "']' expected", or "';' expected" as mandatory repair requirements.
- Verify balanced (), {}, and [] delimiters.
- Verify incomplete function/if/for/while blocks are properly closed.
- Preserve unrelated valid code and original logic.
- Do not add explanations.
- Do not use markdown code fences.
- Return only the final corrected block inside the JSON field "fix".
`,

                                                stream: false,

                                                think: false,

                                                format: {
                                                    type:
                                                        'object',

                                                    properties: {
                                                        fix: {
                                                            type:
                                                                'string'
                                                        }
                                                    },

                                                    required: [
                                                        'fix'
                                                    ]
                                                },

                                                options: {
                                                    temperature:
                                                        0,

                                                    num_predict:
                                                        1000
                                                }
                                            })
                                    }
                                );

                            if (verificationResponse.ok) {

                                const verificationData =
                                    await verificationResponse.json() as {
                                        response: string;
                                    };

                                const verificationParsed =
                                    JSON.parse(
                                        verificationData.response
                                    ) as {
                                        fix: string;
                                    };

                                const verifiedFix =
                                    verificationParsed.fix
                                        .replace(/\\r\\n/g, '\n')
                                        .replace(/\\n/g, '\n')
                                        .trimEnd();

                                if (verifiedFix.trim()) {
                                    cleanFix = verifiedFix;
                                }
                            }
                        }

                        // --------------------------------------------------
                        // DETERMINISTIC FALLBACK FOR EXPLICIT MISSING CLOSERS
                        // --------------------------------------------------
                        // Small local models can occasionally acknowledge a
                        // diagnostic such as "'}' expected" or "')' expected"
                        // but still forget to insert the token. When VS Code has
                        // explicitly reported the missing closer, enforce that
                        // one token deterministically instead of trusting the
                        // model a third time.
                        const enforceExpectedClosers = (
                            candidate: string
                        ): string => {

                            const lines =
                                candidate.split('\n');

                            const countToken = (
                                source: string,
                                token: string
                            ): number =>
                                source.split(token).length - 1;

                            for (const diagnostic of diagnostics) {

                                const message =
                                    diagnostic.message;

                                let token = '';

                                if (/['"]?}['"]?\s*expected/i.test(message)) {
                                    token = '}';
                                } else if (/['"]?\)['"]?\s*expected/i.test(message)) {
                                    token = ')';
                                } else if (/['"]?\]['"]?\s*expected/i.test(message)) {
                                    token = ']';
                                }

                                if (!token) {
                                    continue;
                                }

                                // If the AI already inserted the missing token,
                                // do not insert a duplicate.
                                if (
                                    countToken(candidate, token) >
                                    countToken(originalBlock, token)
                                ) {
                                    continue;
                                }

                                const localLine =
                                    Math.max(
                                        0,
                                        Math.min(
                                            lines.length - 1,
                                            diagnostic.range.start.line -
                                                startLine
                                        )
                                    );

                                if (token === '}') {

                                    let insertionLine =
                                        localLine;

                                    // If we located the unmatched opening brace,
                                    // prefer closing it immediately before the next
                                    // sibling declaration at the same indentation.
                                    // Example:
                                    // function addComment() { ...
                                    // function deleteComment() { ...
                                    // The missing } belongs BEFORE deleteComment,
                                    // not at the EOF diagnostic line.
                                    if (
                                        structuralOpeningLine !== undefined &&
                                        structuralOpeningLine >= startLine &&
                                        structuralOpeningLine <= endLine
                                    ) {

                                        const openerLocalLine =
                                            structuralOpeningLine - startLine;

                                        const openerText =
                                            lines[openerLocalLine] ?? '';

                                        const openerIndentation =
                                            openerText.match(/^\s*/)?.[0] ?? '';

                                        const siblingDeclaration =
                                            /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|enum|namespace)\b/;

                                        for (let index = openerLocalLine + 1; index < lines.length; index++) {

                                            const candidateLine =
                                                lines[index] ?? '';

                                            const candidateIndentation =
                                                candidateLine.match(/^\s*/)?.[0] ?? '';

                                            if (
                                                candidateIndentation === openerIndentation &&
                                                siblingDeclaration.test(
                                                    candidateLine.trimStart()
                                                )
                                            ) {
                                                insertionLine = index;
                                                break;
                                            }
                                        }
                                    }

                                    const targetLine =
                                        lines[insertionLine] ?? '';

                                    const indentation =
                                        targetLine.match(/^\s*/)?.[0] ?? '';

                                    lines.splice(
                                        insertionLine,
                                        0,
                                        `${indentation}}`
                                    );

                                } else {

                                    const targetLine =
                                        lines[localLine] ?? '';

                                    const insertAt =
                                        Math.max(
                                            0,
                                            Math.min(
                                                targetLine.length,
                                                diagnostic.range.start.character
                                            )
                                        );

                                    lines[localLine] =
                                        targetLine.slice(0, insertAt) +
                                        token +
                                        targetLine.slice(insertAt);
                                }

                                candidate =
                                    lines.join('\n');
                            }

                            return candidate;
                        };

                        cleanFix =
                            enforceExpectedClosers(cleanFix);

                        if (cleanFix === originalBlock) {

                            throw new Error(
                                'AI returned the same code for Fix All.'
                            );
                        }

                        this.latestFixAllRange =
                            combinedRange;

                        this.latestFixAllUri =
                            targetUri;

                        this.latestFixAllOriginalText =
                            originalBlock;

                        this.latestFixAllProposedText =
                            cleanFix;

                        webviewView.webview.postMessage({
                            command: 'fixAllReady',
                            text: cleanFix
                        });

                    } catch (fixAllError) {

                        console.error(
                            'CodePilot Fix All Preview Error:',
                            fixAllError
                        );

                        this.latestFixAllRange =
                            undefined;

                        this.latestFixAllUri =
                            undefined;

                        this.latestFixAllOriginalText =
                            undefined;

                        this.latestFixAllProposedText =
                            undefined;

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: '❌ CodePilot could not generate a safe Fix All preview.'
                        });
                    }
                }


                // ==================================================
                // APPLY ALL FIXES
                // ==================================================

                if (
                    message.command ===
                    'applyFixAll'
                ) {

                    const uri =
                        this.latestFixAllUri;

                    const replacementRange =
                        this.latestFixAllRange;

                    const originalText =
                        this.latestFixAllOriginalText;

                    const proposedText =
                        typeof message.fix === 'string'
                            ? message.fix
                            : this.latestFixAllProposedText;

                    if (
                        !uri ||
                        !replacementRange ||
                        !originalText ||
                        !proposedText
                    ) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No Fix All preview is ready.'
                        });

                        return;
                    }

                    try {

                        const document =
                            await vscode.workspace.openTextDocument(
                                uri
                            );

                        if (
                            document.getText(
                                replacementRange
                            ) !== originalText
                        ) {

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '⚠️ The code changed after Fix All was generated. Generate the preview again before applying.'
                            });

                            return;
                        }

                        const edit =
                            new vscode.WorkspaceEdit();

                        edit.replace(
                            uri,
                            replacementRange,
                            proposedText
                        );

                        const applied =
                            await vscode.workspace.applyEdit(
                                edit
                            );

                        if (!applied) {

                            throw new Error(
                                'VS Code rejected the Fix All edit.'
                            );
                        }

                        await document.save();

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: '✅ Fixes applied. 🔄 Re-checking diagnostics...'
                        });

                        // Diagnostics from language extensions refresh
                        // asynchronously after an edit/save. Poll briefly before
                        // claiming that every detected error has been resolved.
                        let remainingErrors: vscode.Diagnostic[] = [];

                        for (
                            let attempt = 0;
                            attempt < 5;
                            attempt++
                        ) {

                            await new Promise<void>(
                                resolve =>
                                    setTimeout(
                                        resolve,
                                        400
                                    )
                            );

                            remainingErrors =
                                vscode.languages
                                    .getDiagnostics(uri)
                                    .filter(
                                        diagnostic =>
                                            diagnostic.severity ===
                                            vscode.DiagnosticSeverity.Error
                                    );

                            if (
                                remainingErrors.length === 0
                            ) {
                                break;
                            }
                        }

                        this.latestFixAllRange =
                            undefined;

                        this.latestFixAllUri =
                            undefined;

                        this.latestFixAllOriginalText =
                            undefined;

                        this.latestFixAllProposedText =
                            undefined;

                        if (
                            remainingErrors.length === 0
                        ) {

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '✅ All detected errors resolved.'
                            });

                        } else {

                            const remainingSummary =
                                remainingErrors
                                    .slice(0, 3)
                                    .map(
                                        diagnostic =>
                                            `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`
                                    )
                                    .join('\n');

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text:
                                    `⚠️ Fixes applied, but ${remainingErrors.length} error(s) are still detected.\n\n${remainingSummary}\n\nRun Fix All Errors again to resolve the newly exposed issue(s).`
                            });
                        }

                        webviewView.webview.postMessage({
                            command: 'clearFixAllPreview'
                        });

                    } catch (applyAllError) {

                        console.error(
                            'CodePilot Apply All Error:',
                            applyAllError
                        );

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: '❌ Could not safely apply all fixes.'
                        });
                    }
                }


                // ==================================================
                // APPLY FIX
                // ==================================================

                if (message.command === 'applyFix') {

                    if (!this.latestDetectedError) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No detected error available.'
                        });

                        return;
                    }

                    const proposedFix =
                        typeof message.fix === 'string'
                            ? message.fix
                            : '';

                    if (!proposedFix.trim()) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No fix available.'
                        });

                        return;
                    }
                    const uri =
                        this.latestProposedFixUri;

                    const replacementRange =
                        this.latestProposedFixRange;

                    if (
                        !uri ||
                        !replacementRange
                    ) {

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: 'No safe multi-line fix range available.'
                        });

                        return;
                    }

                    try {

                        const document =
                            await vscode.workspace.openTextDocument(uri);

                        const originalText =
                            this.latestProposedOriginalText;

                        if (
                            originalText === undefined ||
                            document.getText(
                                replacementRange
                            ) !== originalText
                        ) {

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '⚠️ The code changed after the fix was generated. Generate the fix again before applying it.'
                            });

                            return;
                        }

                        const editor =
                            await vscode.window.showTextDocument(document);

                        const success =
                            await editor.edit(
                                editBuilder => {

                                    editBuilder.replace(
                                        replacementRange,
                                        proposedFix
                                    );
                                }
                            );

                        if (success) {

                            await document.save();

                            this.latestProposedFix =
                                undefined;

                            this.latestProposedFixRange =
                                undefined;

                            this.latestProposedFixUri =
                                undefined;

                            this.latestProposedOriginalText =
                                undefined;

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '✅ Fix applied successfully.'
                            });

                        } else {

                            webviewView.webview.postMessage({
                                command: 'aiResponse',
                                text: '❌ VS Code could not apply the fix.'
                            });
                        }

                    } catch (error) {

                        console.error(
                            'Apply Fix Error:',
                            error
                        );

                        webviewView.webview.postMessage({
                            command: 'aiResponse',
                            text: '❌ Could not apply the fix.'
                        });
                    }
                }

            }
        );
        // ==================================================
        // SIDEBAR UI
        // ==================================================

        webviewView.webview.html = `
<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<style>

body {
    font-family: var(--vscode-font-family);
    padding: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
}

h2 {
    margin-bottom: 12px;
}

textarea {
    width: 100%;
    min-height: 90px;
    resize: vertical;
    padding: 10px;
    box-sizing: border-box;

    border: 1px solid var(--vscode-input-border);

    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
}
select {
    width: 100%;
    margin-top: 8px;
    padding: 8px;

    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);

    border: 1px solid var(--vscode-dropdown-border);
}

button {
    width: 100%;
    margin-top: 10px;
    padding: 10px;

    border: none;
    cursor: pointer;

    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

button:hover {
    background: var(--vscode-button-hoverBackground);
}

button:disabled {
    opacity: 0.65;
    cursor: not-allowed;
}

#errorBox {
    display: none;

    margin-top: 15px;
    padding: 10px;

    border: 1px solid
        var(--vscode-inputValidation-errorBorder);

    background:
        var(--vscode-inputValidation-errorBackground);
}

#errorTitle {
    font-weight: bold;
    margin-bottom: 7px;
}

#errorCode {
    margin-top: 8px;

    font-family:
        var(--vscode-editor-font-family);
}

#fixPreview {
    display: none;

    margin-top: 15px;
    padding: 10px;

    border:
        1px solid var(--vscode-focusBorder);
}

#fixCode {
    margin-top: 8px;

    white-space: pre-wrap;

    font-family:
        var(--vscode-editor-font-family);
}

#fixAllPreview {
    display: none;

    margin-top: 15px;
    padding: 10px;

    border:
        1px solid var(--vscode-focusBorder);
}

#fixAllCode {
    margin-top: 8px;

    white-space: pre-wrap;

    font-family:
        var(--vscode-editor-font-family);
}

#response {
    margin-top: 15px;
    line-height: 1.6;
    padding: 10px;
    border-radius: 6px;
    overflow-wrap: anywhere;
}

#ragSources {
    margin-top: 10px;
    font-size: 12px;
    opacity: 0.8;
    line-height: 1.5;
}

#response h1,
#response h2,
#response h3 {
    margin-top: 12px;
    margin-bottom: 6px;
}

#response pre {
    padding: 10px;
    overflow-x: auto;
    border-radius: 5px;
    background: var(--vscode-textCodeBlock-background);
}

#response code {
    font-family: var(--vscode-editor-font-family);
}

#response p {
    margin: 7px 0;
}

.quick-actions {
    margin-top: 18px;
}

.quick-actions button {
    margin-top: 6px;
}

.sourceLink {
    display: block;
    width: auto;
    padding: 3px 0;
    margin: 3px 0;

    background: transparent;
    color: var(--vscode-textLink-foreground);

    border: none;
    text-align: left;

    cursor: pointer;
}

.sourceLink:hover {
    text-decoration: underline;
    background: transparent;
}

</style>

</head>


<body>


<h2>
    🤖 CodePilot AI
</h2>


<textarea
    id="prompt"
    placeholder="Ask CodePilot anything..."
></textarea>

<select id="responseMode">
    <option value="fast">⚡ Fast</option>
    <option value="normal" selected>Normal</option>
    <option value="detailed">Detailed</option>
</select>

<button id="askButton">
    Ask AI
</button>

<button id="indexProjectButton">
    Index Project
</button>

<div id="ragStatus"></div>

<div id="errorBox">

    <div id="errorTitle">
        ⚠️ Detected Error
    </div>

    <div id="errorMessage"></div>

    <div id="errorCode"></div>


    <button id="explainDetectedErrorButton">
        Explain Error
    </button>


    <button id="generateFixButton">
        Generate Fix
    </button>

    <button id="fixAllErrorsButton">
        Fix All Errors
    </button>

</div>


<div id="fixPreview">

    <strong>
        Proposed Fix
    </strong>

    <div id="fixCode"></div>

<button id="copyFixButton">
    Copy Fix
</button>


    <button id="applyFixButton">
        Apply Fix
    </button>

</div>


<div id="fixAllPreview">

    <strong>
        Proposed Fix All
    </strong>

    <div id="fixAllCode"></div>

    <button id="copyFixAllButton">
        Copy Fix All
    </button>

    <button id="applyFixAllButton">
        Apply All Fixes
    </button>

</div>


<div id="response"></div>

<div id="ragSources"></div>

<button id="copyResponseButton">
    Copy Response
</button>

<div class="quick-actions">

<strong>
    Quick Actions
</strong>


<button id="explainSelectedButton">
    Explain Selected Code
</button>


<button id="fixErrorButton">
    Fix Selected Code
</button>


<button id="improveCodeButton">
    Improve Code
</button>

</div>


<script>

const vscode =
    acquireVsCodeApi();


const askButton =
    document.getElementById(
        'askButton'
    );

const indexProjectButton =
    document.getElementById(
        'indexProjectButton'
    );

const ragStatus =
    document.getElementById(
        'ragStatus'
    );

const promptInput =
    document.getElementById(
        'prompt'
    );

const responseMode =
    document.getElementById(
        'responseMode'
    );


const responseBox =
    document.getElementById(
        'response'
    );

const ragSources =
    document.getElementById(
        'ragSources'
    );

const copyResponseButton =
    document.getElementById(
        'copyResponseButton'
    );

let streamedText = '';

let isAsking = false;
let isGeneratingFix = false;
let isFixingAllErrors = false;
let isIndexingProject = false;

function setButtonLoading(
    button,
    loading,
    loadingText,
    normalText
) {

    button.disabled = loading;
    button.textContent =
        loading
            ? loadingText
            : normalText;
}

function resetAskButton() {
    isAsking = false;
    setButtonLoading(
        askButton,
        false,
        'Thinking...',
        'Ask AI'
    );
}

function resetGenerateFixButton() {
    isGeneratingFix = false;
    setButtonLoading(
        generateFixButton,
        false,
        'Generating...',
        'Generate Fix'
    );
}

function resetFixAllErrorsButton() {
    isFixingAllErrors = false;
    setButtonLoading(
        fixAllErrorsButton,
        false,
        'Fixing All...',
        'Fix All Errors'
    );
}

function resetIndexButton() {
    isIndexingProject = false;
    setButtonLoading(
        indexProjectButton,
        false,
        'Indexing...',
        'Index Project'
    );
}



const errorBox =
    document.getElementById(
        'errorBox'
    );


const errorMessage =
    document.getElementById(
        'errorMessage'
    );


const errorCode =
    document.getElementById(
        'errorCode'
    );


const explainDetectedErrorButton =
    document.getElementById(
        'explainDetectedErrorButton'
    );


const generateFixButton =
    document.getElementById(
        'generateFixButton'
    );

const fixAllErrorsButton =
    document.getElementById(
        'fixAllErrorsButton'
    );


const fixPreview =
    document.getElementById(
        'fixPreview'
    );


const fixCode =
    document.getElementById(
        'fixCode'
    );

const copyFixButton =
    document.getElementById(
        'copyFixButton'
    );


const applyFixButton =
    document.getElementById(
        'applyFixButton'
    );

const fixAllPreview =
    document.getElementById(
        'fixAllPreview'
    );

const fixAllCode =
    document.getElementById(
        'fixAllCode'
    );

const copyFixAllButton =
    document.getElementById(
        'copyFixAllButton'
    );

const applyFixAllButton =
    document.getElementById(
        'applyFixAllButton'
    );


const explainSelectedButton =
    document.getElementById(
        'explainSelectedButton'
    );


const fixErrorButton =
    document.getElementById(
        'fixErrorButton'
    );


const improveCodeButton =
    document.getElementById(
        'improveCodeButton'
    );

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderMarkdown(text) {

    let safe =
        escapeHtml(text);

    // Code blocks
    safe = safe.replace(
        /\`\`\`[a-zA-Z]*\\n([\\s\\S]*?)\`\`\`/g,
        '<pre><code>$1</code></pre>'
    );

    // Headings
    safe = safe.replace(
        /^### (.*)$/gm,
        '<h3>$1</h3>'
    );

    safe = safe.replace(
        /^## (.*)$/gm,
        '<h2>$1</h2>'
    );

    safe = safe.replace(
        /^# (.*)$/gm,
        '<h1>$1</h1>'
    );

    // Bold
    safe = safe.replace(
        /\\*\\*(.*?)\\*\\*/g,
        '<strong>$1</strong>'
    );

    // Inline code
    safe = safe.replace(
        /\`([^\\n]+?)\`/g,
        '<code>$1</code>'
    );

    // New lines
    safe = safe.replace(
        /\\n/g,
        '<br>'
    );

    return safe;
}

// ==================================================
// RECEIVE EXTENSION MESSAGES
// ==================================================

window.addEventListener(
    'message',
    event => {

        const message =
            event.data;

        if (
    message.command ===
    'clearDetectedError'
) {

    errorBox.style.display =
        'none';

    fixPreview.style.display =
        'none';

    fixAllPreview.style.display =
        'none';

    fixAllCode.textContent =
        '';

    errorMessage.textContent =
        '';

    errorCode.textContent =
        '';
}

if (
    message.command ===
    'clearSingleFixPreview'
) {

    fixPreview.style.display =
        'none';

    fixCode.textContent =
        '';
}

if (
    message.command ===
    'clearFixAllPreview'
) {

    fixAllPreview.style.display =
        'none';

    fixAllCode.textContent =
        '';
}

        if (
    message.command ===
    'ragSources'
) {

    if (
        !message.sources ||
        message.sources.length === 0
    ) {

        ragSources.textContent = '';
        return;
    }

    ragSources.innerHTML =
        '<strong>Sources:</strong><br>' +
        message.sources
            .map(
                source =>
                    '<button class="sourceLink" data-source="' +
                    source +
                    '">' +
                    '📄 ' +
                    source +
                    '</button>'
            )
            .join('');

    document
        .querySelectorAll('.sourceLink')
        .forEach(button => {

            button.addEventListener(
                'click',
                () => {

                    vscode.postMessage({
                        command: 'openSourceFile',
                        source: button.dataset.source
                    });
                }
            );
        });
}

if (
    message.command ===
    'ragStatus'
) {

    ragStatus.textContent =
        message.text;

    if (
        isIndexingProject &&
        (
            message.text.includes('✅ Indexed') ||
            message.text.includes('❌ Could not index')
        )
    ) {
        resetIndexButton();
    }
}


        // --------------------------------
        // NORMAL STREAM START
        // --------------------------------

        if (
            message.command ===
            'streamStart'
        ) {
            streamedText = '';
            responseBox.innerHTML = '';
        }


        // --------------------------------
        // NORMAL STREAM CHUNK
        // --------------------------------

       if (
            message.command ===
            'streamChunk'
) {

    streamedText +=
        message.text;

    responseBox.innerHTML =
        renderMarkdown(streamedText);
}


        // --------------------------------
        // NORMAL RESPONSE
        // --------------------------------

        if (
            message.command ===
            'aiResponse'
        ) {
            responseBox.innerHTML =
                renderMarkdown(message.text);

            if (isAsking) {
                resetAskButton();
            }

            if (isGeneratingFix) {
                resetGenerateFixButton();
            }

            if (isFixingAllErrors) {
                resetFixAllErrorsButton();
            }
        }


        // --------------------------------
        // DETECTED ERROR
        // --------------------------------

        if (
            message.command ===
            'detectedError'
        ) {

            errorBox.style.display =
                'block';


            fixPreview.style.display =
                'none';


            errorMessage.textContent =
                message.error;


            errorCode.textContent =
                'Line ' +
                message.line +
                ': ' +
                message.code;
        }


        // --------------------------------
        // FIX STREAM START
        // --------------------------------

        if (
            message.command ===
            'fixStreamStart'
        ) {

            responseBox.textContent =
                'Generating fix...';


            fixPreview.style.display =
                'block';


            fixCode.textContent =
                '';
        }


        // --------------------------------
        // FIX STREAM CHUNK
        // --------------------------------

        if (
            message.command ===
            'fixStreamChunk'
        ) {

            responseBox.textContent =
                '';


            fixCode.textContent +=
                message.text;
        }


        // --------------------------------
        // FIX COMPLETE
        // --------------------------------

        if (
            message.command ===
            'fixReady'
        ) {

            responseBox.textContent =
                '';


            fixPreview.style.display =
                'block';


            fixCode.textContent =
                message.text;

            if (isGeneratingFix) {
                resetGenerateFixButton();
            }
        }


        if (
            message.command ===
            'fixAllReady'
        ) {

            responseBox.textContent =
                '';

            fixPreview.style.display =
                'none';

            fixCode.textContent =
                '';

            fixAllPreview.style.display =
                'block';

            fixAllCode.textContent =
                message.text;

            if (isFixingAllErrors) {
                resetFixAllErrorsButton();
            }
        }
    }
);



// ==================================================
// ASK AI
// ==================================================

askButton.addEventListener(
    'click',

    () => {

        const text =
            promptInput.value.trim();


        if (!text || isAsking) {
            return;
        }

        isAsking = true;

        setButtonLoading(
            askButton,
            true,
            'Thinking...',
            'Ask AI'
        );


        vscode.postMessage({
            command: 'askAI',
            text,
            mode: responseMode.value
        });
    }
);



// ==================================================
// EXPLAIN DETECTED ERROR
// ==================================================

explainDetectedErrorButton.addEventListener(
    'click',

    () => {

        vscode.postMessage({
            command:
                'explainDetectedError'
        });
    }
);



// ==================================================
// GENERATE FIX
// ==================================================

generateFixButton.addEventListener(
    'click',

    () => {

        if (isGeneratingFix) {
            return;
        }

        isGeneratingFix = true;

        setButtonLoading(
            generateFixButton,
            true,
            'Generating...',
            'Generate Fix'
        );

        vscode.postMessage({
            command: 'generateFix'
        });
    }
);


fixAllErrorsButton.addEventListener(
    'click',

    () => {

        if (isFixingAllErrors) {
            return;
        }

        isFixingAllErrors = true;

        setButtonLoading(
            fixAllErrorsButton,
            true,
            'Fixing All...',
            'Fix All Errors'
        );

        vscode.postMessage({
            command: 'fixAllErrors'
        });
    }
);



// ==================================================
// APPLY FIX
// ==================================================

applyFixButton.addEventListener(
    'click',

    () => {

        const fix =
            fixCode.textContent;

        if (!fix.trim()) {
            return;
        }

        vscode.postMessage({
            command: 'applyFix',
            fix
        });
    }
);


applyFixAllButton.addEventListener(
    'click',

    () => {

        const fix =
            fixAllCode.textContent;

        if (!fix.trim()) {
            return;
        }

        vscode.postMessage({
            command: 'applyFixAll',
            fix
        });
    }
);


// ==================================================
// EXPLAIN SELECTED
// ==================================================

explainSelectedButton.addEventListener(
    'click',

    () => {

        vscode.postMessage({
            command:
                'explainSelectedCode'
        });
    }
);



// ==================================================
// FIX SELECTED
// ==================================================

fixErrorButton.addEventListener(
    'click',

    () => {

        vscode.postMessage({
            command: 'fixError'
        });
    }
);



// ==================================================
// IMPROVE CODE
// ==================================================

improveCodeButton.addEventListener(
    'click',

    () => {

        vscode.postMessage({
            command: 'improveCode'
        });
    }
);

indexProjectButton.addEventListener(
    'click',
    () => {

        if (isIndexingProject) {
            return;
        }

        isIndexingProject = true;

        setButtonLoading(
            indexProjectButton,
            true,
            'Indexing...',
            'Index Project'
        );

        vscode.postMessage({
            command: 'indexProject'
        });
    }
);

copyResponseButton.addEventListener(
    'click',
    async () => {

        const text =
            responseBox.innerText.trim();

        if (!text) {
            return;
        }

        await navigator.clipboard.writeText(text);

        const oldText =
            copyResponseButton.textContent;

        copyResponseButton.textContent =
            'Copied ✓';

        setTimeout(() => {
            copyResponseButton.textContent =
                oldText;
        }, 1200);
    }
);

copyFixButton.addEventListener(
    'click',
    async () => {

        const text =
            fixCode.textContent.trim();

        if (!text) {
            return;
        }

        await navigator.clipboard.writeText(text);

        const oldText =
            copyFixButton.textContent;

        copyFixButton.textContent =
            'Copied ✓';

        setTimeout(() => {
            copyFixButton.textContent =
                oldText;
        }, 1200);
    }
);


copyFixAllButton.addEventListener(
    'click',
    async () => {

        const text =
            fixAllCode.textContent;

        if (!text.trim()) {
            return;
        }

        await navigator.clipboard.writeText(text);

        const oldText =
            copyFixAllButton.textContent;

        copyFixAllButton.textContent =
            'Copied ✓';

        setTimeout(() => {
            copyFixAllButton.textContent =
                oldText;
        }, 1200);
    }
);



</script>


</body>

</html>
        `;
    }


    // ==================================================
    // RECEIVE DETECTED ERROR FROM extension.ts
    // ==================================================

    public showDetectedError(
        error: string,
        line: number,
        code: string,
        uri: vscode.Uri,
        range: vscode.Range
    ): void {

        this.latestDetectedError = {
            error,
            line,
            code,
            uri,
            range
        };

        this.view?.webview.postMessage({
            command: 'detectedError',
            error,
            line,
            code
        });
    }


    public clearDetectedError(): void {

        this.latestDetectedError =
            undefined;

        this.latestProposedFix =
            undefined;

        this.latestProposedFixRange =
            undefined;

        this.latestProposedFixUri =
            undefined;

        this.latestProposedOriginalText =
            undefined;

        this.latestFixAllRange =
            undefined;

        this.latestFixAllUri =
            undefined;

        this.latestFixAllOriginalText =
            undefined;

        this.latestFixAllProposedText =
            undefined;

        this.view?.webview.postMessage({
            command: 'clearDetectedError'
        });
    }

}