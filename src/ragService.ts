import * as vscode from 'vscode';

import { OllamaEmbeddings } from '@langchain/ollama';

import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

import { Document } from '@langchain/core/documents';


export class RagService {

    // One vector store per project file.
    // This lets CodePilot replace only the saved file's embeddings
    // instead of rebuilding the entire project index.
    private fileStores =
        new Map<string, MemoryVectorStore>();

    private isIndexed = false;


    // -----------------------------------------
    // EMBEDDING MODEL
    // -----------------------------------------

    private embeddings =
        new OllamaEmbeddings({
            model: 'nomic-embed-text',
            baseUrl: 'http://localhost:11434'
        });


    // -----------------------------------------
    // TEXT SPLITTER
    // -----------------------------------------

    private splitter =
        new RecursiveCharacterTextSplitter({
            chunkSize: 1200,
            chunkOverlap: 200
        });


    // -----------------------------------------
    // FILE TYPES WE WANT TO INDEX
    // -----------------------------------------

    private supportedExtensions = [
        'ts',
        'tsx',
        'js',
        'jsx',
        'html',
        'css',
        'json',
        'py',
        'java',
        'cpp',
        'c',
        'h',
        'hpp',
        'md'
    ];


    // ==================================================
    // CHECK WHETHER A FILE IS SUPPORTED
    // ==================================================

    private isSupportedFile(
        uri: vscode.Uri
    ): boolean {

        const extension =
            uri.path
                .split('.')
                .pop()
                ?.toLowerCase();

        return Boolean(
            extension &&
            this.supportedExtensions.includes(
                extension
            )
        );
    }


    // ==================================================
    // CREATE CHUNKS FOR ONE FILE
    // ==================================================

    private async createChunksForFile(
        file: vscode.Uri
    ): Promise<Document[]> {

        if (!this.isSupportedFile(file)) {
            return [];
        }

        const document =
            await vscode.workspace.openTextDocument(
                file
            );

        const text =
            document.getText();


        // Ignore empty files

        if (!text.trim()) {
            return [];
        }


        // Avoid huge files for now

        if (text.length > 100000) {
            return [];
        }


        const relativePath =
            vscode.workspace.asRelativePath(
                file
            );


        const sourceDocument =
            new Document({
                pageContent: text,

                metadata: {
                    source: relativePath,
                    language:
                        document.languageId
                }
            });


        return this.splitter.splitDocuments(
            [sourceDocument]
        );
    }


    // ==================================================
    // INDEX CURRENT VS CODE PROJECT
    // ==================================================

    public async indexWorkspace(): Promise<number> {

        const workspaceFolders =
            vscode.workspace.workspaceFolders;


        if (!workspaceFolders) {

            throw new Error(
                'No workspace folder is open.'
            );
        }


        // -----------------------------------------
        // FIND PROJECT FILES
        // -----------------------------------------

        const files =
            await vscode.workspace.findFiles(
                '**/*',
                '**/{node_modules,.git,dist,out,build,coverage}/**'
            );


        const nextFileStores =
            new Map<string, MemoryVectorStore>();

        let indexedFileCount = 0;
        let totalChunkCount = 0;


        // -----------------------------------------
        // INDEX EACH FILE SEPARATELY
        // -----------------------------------------

        for (const file of files) {

            if (!this.isSupportedFile(file)) {
                continue;
            }


            try {

                const chunks =
                    await this.createChunksForFile(
                        file
                    );


                if (chunks.length === 0) {
                    continue;
                }


                const relativePath =
                    vscode.workspace.asRelativePath(
                        file
                    );


                const store =
                    await MemoryVectorStore.fromDocuments(
                        chunks,
                        this.embeddings
                    );


                nextFileStores.set(
                    relativePath,
                    store
                );


                indexedFileCount += 1;

                totalChunkCount +=
                    chunks.length;


            } catch (error) {

                console.error(
                    'CodePilot RAG file indexing error:',
                    file.fsPath,
                    error
                );
            }
        }


        if (indexedFileCount === 0) {

            throw new Error(
                'No supported project files found.'
            );
        }


        // Replace the old project index only after
        // the new full index has completed.
        this.fileStores =
            nextFileStores;

        this.isIndexed =
            true;


        console.log(
            `CodePilot indexed ${indexedFileCount} files and ${totalChunkCount} chunks.`
        );


        return indexedFileCount;
    }


    // ==================================================
    // INCREMENTALLY INDEX ONE SAVED FILE
    // ==================================================

    public async indexFile(
        file: vscode.Uri
    ): Promise<void> {

        const workspaceFolders =
            vscode.workspace.workspaceFolders;


        if (!workspaceFolders) {

            throw new Error(
                'No workspace folder is open.'
            );
        }


        const relativePath =
            vscode.workspace.asRelativePath(
                file
            );


        // If this file used to be indexed but is no longer
        // supported, remove its old in-memory index.
        if (!this.isSupportedFile(file)) {

            this.fileStores.delete(
                relativePath
            );

            this.isIndexed =
                this.fileStores.size > 0;

            return;
        }


        try {

            const chunks =
                await this.createChunksForFile(
                    file
                );


            // Empty or oversized files should no longer
            // contribute stale RAG context.
            if (chunks.length === 0) {

                this.fileStores.delete(
                    relativePath
                );

                this.isIndexed =
                    this.fileStores.size > 0;

                console.log(
                    `CodePilot removed ${relativePath} from the RAG index.`
                );

                return;
            }


            const newStore =
                await MemoryVectorStore.fromDocuments(
                    chunks,
                    this.embeddings
                );


            // Replacing this Map entry discards only this
            // file's previous vectors.
            this.fileStores.set(
                relativePath,
                newStore
            );


            this.isIndexed =
                true;


            console.log(
                `CodePilot indexed changed file ${relativePath} (${chunks.length} chunks).`
            );


        } catch (error) {

            console.error(
                'CodePilot incremental file indexing error:',
                file.fsPath,
                error
            );

            throw error;
        }
    }


    // ==================================================
    // SEARCH PROJECT
    // ==================================================

    public async searchProject(
        question: string,
        limit: number = 4
    ): Promise<string> {


        if (
            !this.isIndexed ||
            this.fileStores.size === 0
        ) {

            throw new Error(
                'Project has not been indexed yet.'
            );
        }


        const combinedResults: {
            document: Document;
            score: number;
        }[] = [];


        // Search each file store, then merge all results.
        // MemoryVectorStore uses similarity scores where
        // larger cosine-similarity values are more relevant.
        for (
            const store of
            this.fileStores.values()
        ) {

            try {

                const results =
                    await store
                        .similaritySearchWithScore(
                            question,
                            limit
                        );


                for (
                    const [
                        document,
                        score
                    ] of results
                ) {

                    combinedResults.push({
                        document:
                            document as Document,
                        score
                    });
                }


            } catch (error) {

                console.error(
                    'CodePilot RAG search error:',
                    error
                );
            }
        }


        if (
            combinedResults.length === 0
        ) {

            return 'No relevant project context found.';
        }


        combinedResults.sort(
            (a, b) =>
                b.score - a.score
        );


        const topResults =
            combinedResults.slice(
                0,
                limit
            );


        // -----------------------------------------
        // FORMAT CONTEXT FOR QWEN
        // -----------------------------------------

        return topResults
            .map(
                (
                    result,
                    index
                ) => {

                    const source =
                        result.document
                            .metadata.source ??
                        'Unknown file';


                    return `
--- Context ${index + 1} ---

File: ${source}

${result.document.pageContent}
`;
                }
            )
            .join('\n');
    }


    // ==================================================
    // CHECK INDEX STATUS
    // ==================================================

    public isProjectIndexed(): boolean {

        return (
            this.isIndexed &&
            this.fileStores.size > 0
        );
    }


    // ==================================================
    // CLEAR INDEX
    // ==================================================

    public clearIndex(): void {

        this.fileStores.clear();

        this.isIndexed =
            false;
    }
}