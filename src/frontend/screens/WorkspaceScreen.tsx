import type { ReactNode } from "react";

interface WorkspaceScreenProps {
  bottomRail: ReactNode;
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
  bottomRail,
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
    <div className="workspace-body">
      <div className="workspace-stage">
        {terminalStage}
      </div>
      {bottomRail ?? (
        <div className="workspace-bottom-rail">
          {fileInput}
          {toolbar}
          {pinnedSnippetsBar}
          {snippetTemplatePanel}
          {composeBar}
          {snippetPicker}
        </div>
      )}
    </div>
  </div>
);
