import * as vscode from 'vscode';
import { CodePilotViewProvider } from './codePilotViewProvider';
import { RagService } from './ragService';

export function activate(context: vscode.ExtensionContext) {

    // RAG service create karo
    const ragService = new RagService();

    // RAG service provider ko do
    const provider = new CodePilotViewProvider(
        context.extensionUri,
        ragService
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'codepilot-chat',
            provider
        )
    );

    // --------------------------------
    // AUTO INDEX PROJECT ON STARTUP
    // --------------------------------

    if (vscode.workspace.workspaceFolders) {

        const startupIndexTimer = setTimeout(
            async () => {

                try {

                    const fileCount =
                        await ragService.indexWorkspace();

                    console.log(
                        `CodePilot automatically indexed ${fileCount} project files.`
                    );

                } catch (error) {

                    console.error(
                        'CodePilot startup indexing failed:',
                        error
                    );
                }

            },
            1500
        );

        context.subscriptions.push({
            dispose: () =>
                clearTimeout(startupIndexTimer)
        });
    }

    // --------------------------------
    // INCREMENTAL RAG RE-INDEX ON SAVE
    // --------------------------------

    let reindexTimer: NodeJS.Timeout | undefined;
    let pendingSavedUri: vscode.Uri | undefined;

    const fileWatcher =
        vscode.workspace.onDidSaveTextDocument(
            (document) => {

                pendingSavedUri =
                    document.uri;

                if (reindexTimer) {
                    clearTimeout(reindexTimer);
                }

                reindexTimer = setTimeout(
                    async () => {

                        const uriToIndex =
                            pendingSavedUri;

                        pendingSavedUri =
                            undefined;

                        if (!uriToIndex) {
                            return;
                        }

                        try {

                            await ragService.indexFile(
                                uriToIndex
                            );

                            console.log(
                                `CodePilot incrementally re-indexed: ${vscode.workspace.asRelativePath(uriToIndex)}`
                            );

                        } catch (error) {

                            console.error(
                                'CodePilot incremental re-index failed:',
                                error
                            );
                        }

                    },
                    1000
                );
            }
        );

    context.subscriptions.push(
        fileWatcher
    );

    context.subscriptions.push({
        dispose: () => {

            if (reindexTimer) {
                clearTimeout(reindexTimer);
            }
        }
    });

    // --------------------------------
    // EXPLAIN CODE COMMAND
    // --------------------------------

    const explainCommand =
        vscode.commands.registerCommand(
            'codepilot-ai.explainCode',
            async () => {

                const editor =
                    vscode.window.activeTextEditor;

                if (!editor) {
                    vscode.window.showErrorMessage(
                        'No active editor found.'
                    );
                    return;
                }

                const selectedCode =
                    editor.document.getText(
                        editor.selection
                    );

                if (!selectedCode.trim()) {
                    vscode.window.showWarningMessage(
                        'Please select some code first.'
                    );
                    return;
                }

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
Explain this code clearly and concisely:

${selectedCode}
                                `,
                                stream: false,
                                think: false
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

                    vscode.window.showInformationMessage(
                        data.response
                    );

                } catch {
                    vscode.window.showErrorMessage(
                        'Could not connect to Ollama.'
                    );
                }
            }
        );

    context.subscriptions.push(
        explainCommand
    );

    // --------------------------------
    // AUTOMATIC ERROR DETECTION
    // --------------------------------

    const diagnosticListener =
        vscode.languages.onDidChangeDiagnostics(
            async (event) => {

                for (const uri of event.uris) {

                    const diagnostics =
                        vscode.languages.getDiagnostics(uri);

                    const errors =
                        diagnostics.filter(
                            diagnostic =>
                                diagnostic.severity ===
                                vscode.DiagnosticSeverity.Error
                        );

                    if (errors.length === 0) {
                        provider.clearDetectedError();
                        continue;
                    }

                    const error =
                        errors[0];

                    try {

                        const document =
                            await vscode.workspace.openTextDocument(
                                uri
                            );

                        const lineNumber =
                            error.range.start.line;

                        const codeLine =
                            document.lineAt(
                                lineNumber
                            ).text;

                        provider.showDetectedError(
                            error.message,
                            lineNumber + 1,
                            codeLine.trim(),
                            uri,
                            error.range
                        );

                    } catch (err) {

                        console.error(
                            'CodePilot could not read error context:',
                            err
                        );
                    }
                }
            }
        );

    context.subscriptions.push(
        diagnosticListener
    );
}

export function deactivate() { }