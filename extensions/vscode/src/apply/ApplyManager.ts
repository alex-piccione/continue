import { ConfigHandler } from "core/config/ConfigHandler";
import { applyCodeBlock } from "core/edit/lazy/applyCodeBlock";
import { getUriPathBasename } from "core/util/uri";
import * as vscode from "vscode";

import { ApplyToFilePayload } from "core";
import { myersDiff } from "core/diff/myers";
import { generateLines } from "core/diff/util";
import { ApplyAbortManager } from "core/edit/applyAbortManager";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

/**
 * Handles applying text/code to files including diff generation and streaming
 */
export class ApplyManager {
  constructor(
    private readonly ide: VsCodeIde,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly verticalDiffManager: VerticalDiffManager,
    private readonly configHandler: ConfigHandler,
  ) {}

  async applyToFile({
    streamId,
    filepath,
    text,
    toolCallId,
    isSearchAndReplace,
  }: ApplyToFilePayload) {
    if (filepath) {
      await this.ensureFileOpen(filepath);
    }

    // console.info/warn/error does not work here

    console.info(`applyToFile. filepath: ${filepath}`);
    void vscode.window?.showInformationMessage(
      `applyToFile. filepath: ${filepath}`,
    );

    let activeTextEditor = vscode.window?.activeTextEditor;
    void vscode.window?.showErrorMessage(
      `vscode.window?.activeTextEditor: ${activeTextEditor}`, // undefined
    );

    if (!activeTextEditor) {
      //console.warn("vscode.window?.activeTextEditor is null or undefined");

      // If vscode.window is not available or activeTextEditor is null, try to find an editor
      if (vscode.workspace.textDocuments.length > 0) {
        try {
          console.info("vscode.workspace.textDocuments.length > 0");
          void vscode.window?.showErrorMessage(
            "vscode.workspace.textDocuments.length > 0",
          );
          const doc = await vscode.workspace.openTextDocument(filepath);
          await vscode.window.showTextDocument(doc, { preview: false });

          void vscode.window?.showErrorMessage(`doc: ${doc}`);

          activeTextEditor = vscode.window.visibleTextEditors.find(
            (editor: { document: any }) => editor.document === doc,
          );

          void vscode.window?.showErrorMessage(
            `vscode.window.visibleTextEditors: ${vscode.window.visibleTextEditors.length}`,
          );

          void vscode.window?.showErrorMessage(
            `vscode.window?.activeTextEditor (from visibleTextEditors): ${activeTextEditor}`,
          );
        } catch (error) {
          console.error(
            `applyToFile. Error opening document "${filepath}". ${error}`,
          );
          void vscode.window?.showErrorMessage(
            `applyToFile. Error opening document "${filepath}". ${error}`,
          );
        }
      } else {
        console.warn("vscode.workspace.textDocuments.length is 0");
        void vscode.window?.showErrorMessage(
          "vscode.workspace.textDocuments.length is 0",
        );
      }
    }

    if (!activeTextEditor) {
      void vscode.window?.showErrorMessage(
        "applyToFile - No active editor found to apply edits to. Ensure a file is open.",
      );
      return;
    }

    // Capture the original file content before applying changes
    const originalFileContent = activeTextEditor.document.getText();

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "streaming",
      fileContent: text,
      originalFileContent,
      toolCallId,
    });

    const hasExistingDocument = !!activeTextEditor.document.getText().trim();
    if (hasExistingDocument) {
      // Currently `isSearchAndReplace` will always provide a full file rewrite
      // as the contents of `text`, so we can just instantly apply
      if (isSearchAndReplace) {
        const diffLinesGenerator = generateLines(
          myersDiff(activeTextEditor.document.getText(), text),
        );

        await this.verticalDiffManager.streamDiffLines(
          diffLinesGenerator,
          true,
          streamId,
          toolCallId,
        );
      } else {
        await this.handleExistingDocument(
          activeTextEditor,
          text,
          streamId,
          toolCallId,
        );
      }
    } else {
      await this.handleEmptyDocument(
        activeTextEditor,
        text,
        streamId,
        toolCallId,
      );
    }
  }

  private async ensureFileOpen(filepath: string): Promise<void> {
    const fileExists = await this.ide.fileExists(filepath);
    if (!fileExists) {
      await this.ide.writeFile(filepath, "");
      await this.ide.openFile(filepath);
    }
    await this.ide.openFile(filepath);
  }

  private async handleEmptyDocument(
    editor: vscode.TextEditor,
    text: string,
    streamId: string,
    toolCallId?: string,
  ) {
    await editor.edit((builder) =>
      builder.insert(new vscode.Position(0, 0), text),
    );

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "closed",
      numDiffs: 0,
      fileContent: text,
      toolCallId,
    });
  }

  private async handleExistingDocument(
    editor: vscode.TextEditor,
    text: string,
    streamId: string,
    toolCallId?: string,
  ) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      void vscode.window.showErrorMessage("Config not loaded");
      return;
    }

    const llm =
      config.selectedModelByRole.apply ?? config.selectedModelByRole.chat;
    if (!llm) {
      void vscode.window.showErrorMessage(
        `No model with roles "apply" or "chat" found in config.`,
      );
      return;
    }

    const fileUri = editor.document.uri.toString();
    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(fileUri);

    const { isInstantApply, diffLinesGenerator } = await applyCodeBlock(
      editor.document.getText(),
      text,
      getUriPathBasename(fileUri),
      llm,
      abortController,
    );

    if (isInstantApply) {
      await this.verticalDiffManager.streamDiffLines(
        diffLinesGenerator,
        isInstantApply,
        streamId,
        toolCallId,
      );
    } else {
      await this.handleNonInstantDiff(
        editor,
        text,
        llm,
        streamId,
        this.verticalDiffManager,
        toolCallId,
      );
    }
  }

  /**
   * Creates a prompt for applying code edits
   */
  private getApplyPrompt(text: string): string {
    return `The following code was suggested as an edit:\n\`\`\`\n${text}\n\`\`\`\nPlease apply it to the previous code.`;
  }

  private async handleNonInstantDiff(
    editor: vscode.TextEditor,
    text: string,
    llm: any,
    streamId: string,
    verticalDiffManager: VerticalDiffManager,
    toolCallId?: string,
  ) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      void vscode.window.showErrorMessage("Config not loaded");
      return;
    }

    const prompt = this.getApplyPrompt(text);
    const fullEditorRange = new vscode.Range(
      0,
      0,
      editor.document.lineCount - 1,
      editor.document.lineAt(editor.document.lineCount - 1).text.length,
    );
    const rangeToApplyTo = editor.selection.isEmpty
      ? fullEditorRange
      : editor.selection;

    await verticalDiffManager.streamEdit({
      input: prompt,
      llm,
      streamId,
      range: rangeToApplyTo,
      newCode: text,
      toolCallId,
      rulesToInclude: undefined, // No rules for apply
    });
  }
}
