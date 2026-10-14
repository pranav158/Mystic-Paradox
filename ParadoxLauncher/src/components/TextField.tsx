import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string;
  hint?: ReactNode;
  hintTone?: "ok" | "muted";
  rightAdornment?: ReactNode;
}

export function TextField({ label, error, hint, hintTone = "muted", rightAdornment, className, ...inputProps }: TextFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label}</label>
      <div className="field-control">
        <input
          id={id}
          className={`input${rightAdornment ? " has-adornment" : ""}${className ? ` ${className}` : ""}`}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          {...inputProps}
        />
        {rightAdornment && <div className="field-adornment">{rightAdornment}</div>}
      </div>
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className={`field-hint${hintTone === "ok" ? " ok" : ""}`}>{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Show/Hide toggle for password fields. [2026-10-14] It is reached with the Tab key (it was skipped before), and its name
 * says what pressing it does, so the name always contains the visible word ("Show" or "Hide").
 */
export function RevealToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn btn-ghost" onClick={onToggle} aria-label={shown ? "Hide password" : "Show password"}>
      {shown ? "Hide" : "Show"}
    </button>
  );
}
