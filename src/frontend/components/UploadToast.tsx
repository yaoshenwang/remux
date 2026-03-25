interface UploadToastProps {
  onDismiss: () => void;
  onInsert: () => void;
  path: string;
}

const UploadToast = ({ onDismiss, onInsert, path }: UploadToastProps) => (
  <div className="upload-toast">
    <span className="upload-toast-path">{path}</span>
    <button
      onClick={onInsert}
      title="Insert the uploaded file path into the terminal"
    >
      Insert
    </button>
    <button onClick={onDismiss} title="Dismiss this notification">×</button>
  </div>
);

export default UploadToast;
