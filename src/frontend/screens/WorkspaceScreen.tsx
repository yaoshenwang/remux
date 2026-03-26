import type { ReactNode } from "react";

interface WorkspaceScreenProps {
  composeBar: ReactNode;
  fileInput: ReactNode;
  header: ReactNode;
  pinnedSnippetsBar: ReactNode;
  snippetPicker: ReactNode;
  snippetTemplatePanel: ReactNode;
  terminalStage: ReactNode;
  toolbar: ReactNode;
}

export const WorkspaceScreen = ({
  composeBar,
  fileInput,
  header,
  pinnedSnippetsBar,
  snippetPicker,
  snippetTemplatePanel,
  terminalStage,
  toolbar,
}: WorkspaceScreenProps) => (
  <div className="main-content">
    {header}
    {terminalStage}
    {fileInput}
    {toolbar}
    {pinnedSnippetsBar}
    {snippetTemplatePanel}
    {composeBar}
    {snippetPicker}
  </div>
);
