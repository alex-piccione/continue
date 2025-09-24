import { BuiltInToolNames } from "core/tools/builtIn";
import { resolveRelativePathInDir } from "core/util/ideUtils";
import { getUriPathBasename } from "core/util/uri";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { setToolCallArgs } from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

export async function enhanceParsedArgs(
  ideMessenger: IIdeMessenger,
  dispatch: AppThunkDispatch,
  toolName: string | undefined,
  toolCallId: string,
  currentArgs: undefined | Record<string, any>,
) {
  // Add file content to parsedArgs for find/replace tools
  let enhancedArgs = { ...currentArgs };
  if (
    (toolName === BuiltInToolNames.SingleFindAndReplace ||
      toolName === BuiltInToolNames.MultiEdit) &&
    currentArgs?.filepath &&
    !currentArgs?.editingFileContents
  ) {
    console.info(
      `enhanceParsedArgs - currentArgs.filepath: ${currentArgs.filepath}`,
    );

    try {
      const fileUri = await resolveRelativePathInDir(
        currentArgs.filepath,
        ideMessenger.ide,
      );

      console.info(`enhanceParsedArgs - fileUri: ${fileUri}`);

      if (!fileUri) {
        throw new Error(`File ${currentArgs.filepath} not found`);
      }
      const baseName = getUriPathBasename(fileUri);

      console.info(`enhanceParsedArgs - baseName: ${baseName}`);

      const fileContent = await ideMessenger.ide.readFile(fileUri);

      console.info(`enhanceParsedArgs - fileContent resolved`);

      enhancedArgs = {
        ...currentArgs,
        fileUri,
        baseName,
        editingFileContents: fileContent,
      };
      dispatch(
        setToolCallArgs({
          toolCallId,
          newArgs: enhancedArgs,
        }),
      );
    } catch (error) {
      // If we can't read the file, let the tool handle the error
      console.error(
        `Failed to enhance args: failed to read file ${currentArgs?.filepath}. ${error}`,
      );
    }
  }
}
