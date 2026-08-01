import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string;
  rightAdornment?: ReactNode;
}

export function TextField({ label, error, rightAdornment, className, ...inputProps }: TextFieldProps) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className={`w-full rounded-lg border bg-bg/60 px-3 py-2.5 text-sm text-text placeholder:text-text-faint transition-[border-color,box-shadow] duration-150 ease-(--ease-out-quart) focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px] focus:shadow-accent/15 disabled:opacity-50 ${
            error ? "border-danger" : "border-border hover:border-border-strong"
          } ${rightAdornment ? "pr-12" : ""} ${className ?? ""}`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          {...inputProps}
        />
        {rightAdornment && <div className="absolute inset-y-0 right-2 flex items-center">{rightAdornment}</div>}
      </div>
      {error && (
        <p id={`${id}-error`} className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
