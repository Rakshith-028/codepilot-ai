import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

    const explainCommand = vscode.commands.registerCommand(
        'codepilot-ai.explainCode',
        async () => {

            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                vscode.window.showErrorMessage('No active editor found.');
                return;
            }

            const selection = editor.selection;
            const selectedCode = editor.document.getText(selection);

            if (!selectedCode.trim()) {
                vscode.window.showWarningMessage(
                    'Please select some code first.'
                );
                return;
            }

            vscode.window.showInformationMessage(
                'CodePilot is analyzing your code...'
            );

            try {
                const response = await fetch(
                    'http://localhost:11434/api/generate',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: 'qwen3:8b',
                            prompt: `Explain this code clearly to a beginner:

${selectedCode}`,
                            stream: false
                        })
                    }
                );

                const data = await response.json() as { response: string };

                vscode.window.showInformationMessage(
                    data.response
                );

            } catch (error) {
                vscode.window.showErrorMessage(
                    'Could not connect to Ollama. Make sure Ollama is running.'
                );
            }
        }
    );

    context.subscriptions.push(explainCommand);
}

export function deactivate() { }