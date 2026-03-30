interface PasswordOverlayProps {
  onChange: (value: string) => void;
  onSubmit: () => void;
  password: string;
  passwordErrorMessage: string;
  showPasswordField?: boolean;
  submitLabel?: string;
  title?: string;
}

const PasswordOverlay = ({
  onChange,
  onSubmit,
  password,
  passwordErrorMessage,
  showPasswordField = true,
  submitLabel = "Connect",
  title = "Password Required",
}: PasswordOverlayProps) => (
  <div className="overlay">
    <div className="card">
      <h2>{title}</h2>
      {showPasswordField ? (
        <input
          type="password"
          value={password}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Enter password"
        />
      ) : null}
      {passwordErrorMessage && (
        <p className="password-error" data-testid="password-error">
          {passwordErrorMessage}
        </p>
      )}
      <button onClick={onSubmit}>{submitLabel}</button>
    </div>
  </div>
);

export default PasswordOverlay;
