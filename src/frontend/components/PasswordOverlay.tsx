interface PasswordOverlayProps {
  onChange: (value: string) => void;
  onSubmit: () => void;
  password: string;
  passwordErrorMessage: string;
}

const PasswordOverlay = ({
  onChange,
  onSubmit,
  password,
  passwordErrorMessage
}: PasswordOverlayProps) => (
  <div className="overlay">
    <div className="card">
      <h2>Password Required</h2>
      <input
        type="password"
        value={password}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Enter password"
      />
      {passwordErrorMessage && (
        <p className="password-error" data-testid="password-error">
          {passwordErrorMessage}
        </p>
      )}
      <button onClick={onSubmit}>Connect</button>
    </div>
  </div>
);

export default PasswordOverlay;
