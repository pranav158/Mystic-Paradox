import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 10.6 12 3.8l8.5 6.8" />
      <path d="M5.8 9v10.2a.8.8 0 0 0 .8.8h3.6v-5.4h3.6V20h3.6a.8.8 0 0 0 .8-.8V9" />
    </Icon>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4" width="5" height="16" rx="1.2" />
      <rect x="10.5" y="4" width="5" height="16" rx="1.2" />
      <path d="m17.6 5.2 2.9 14.1" />
    </Icon>
  );
}

export function AccountIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.2" r="3.8" />
      <path d="M4.6 20c1.3-3.6 4.2-5.4 7.4-5.4s6.1 1.8 7.4 5.4" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z" />
      <path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.8 7.8 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A7.8 7.8 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.8 7.8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.8 7.8 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z" />
    </Icon>
  );
}

export function AboutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6h.01" strokeWidth="2.4" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M7.6 4.9c-.8-.5-1.8.1-1.8 1v12.2c0 .9 1 1.5 1.8 1l10-6.1a1.2 1.2 0 0 0 0-2l-10-6.1Z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function BuildIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3.5 8 4.6-8 4.6-8-4.6 8-4.6Z" />
      <path d="m4 12.2 8 4.6 8-4.6M4 16.3l8 4.6 8-4.6" />
    </Icon>
  );
}

export function RuntimeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8l-7.6-4.4V7.6L12 3.2Z" />
      <path d="M12 8.2 15.3 10v4L12 15.8 8.7 14v-4L12 8.2Z" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 5v5h-5" />
      <path d="M19.4 10A7.5 7.5 0 0 0 6 7.2" />
      <path d="M4 19v-5h5" />
      <path d="M4.6 14A7.5 7.5 0 0 0 18 16.8" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h4l2 2.2h7.6a1.7 1.7 0 0 1 1.7 1.7v8.4a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.2Z" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15.5V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.3 19 6v5.6c0 4.3-2.9 7.7-7 9.1-4.1-1.4-7-4.8-7-9.1V6l7-2.7Z" />
      <path d="m9 12 2.1 2.1L15.2 10" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8" />
      <path d="M3.5 4.5v4h4" />
      <path d="M12 8v4.2l2.8 1.8" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6h4" />
    </Icon>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5" />
      <path d="M10 16.5 5.5 12 10 7.5" />
      <path d="M5.5 12h10" />
    </Icon>
  );
}

export function ZoomIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9" />
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9" />
      <path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
      <path d="M9.5 12h5M12 9.5v5" />
    </Icon>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </Icon>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5Z" />
      <path d="M18.5 15.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 4.2 2.9 17.1A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.8h.01" strokeWidth="2.4" />
    </Icon>
  );
}

/** Co-op connection: three linked peers. */
export function CoopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6.5" r="2.5" />
      <circle cx="18" cy="17.5" r="2.5" />
      <path d="m8.3 10.9 7.4-3.3" />
      <path d="m8.3 13.1 7.4 3.3" />
    </Icon>
  );
}

export function DiscordIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M18.9 5.6A16.3 16.3 0 0 0 15 4.4l-.5 1a15 15 0 0 0-4.9 0l-.5-1a16.3 16.3 0 0 0-3.9 1.2C2.7 9.3 2 12.9 2.4 16.5a16.4 16.4 0 0 0 4.8 2.4l1-1.6a10.6 10.6 0 0 1-1.6-.8l.4-.3a11.7 11.7 0 0 0 10 0l.4.3c-.5.3-1 .6-1.6.8l1 1.6a16.4 16.4 0 0 0 4.8-2.4c.5-4.2-.8-7.8-2.7-10.9ZM9 14.3c-.9 0-1.7-.9-1.7-1.9S8 10.5 9 10.5s1.7.9 1.7 1.9-.8 1.9-1.7 1.9Zm6 0c-.9 0-1.7-.9-1.7-1.9s.8-1.9 1.7-1.9 1.7.9 1.7 1.9-.8 1.9-1.7 1.9Z" />
    </svg>
  );
}

export function MinimizeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" {...props}>
      <path d="M3.5 8h9" />
    </svg>
  );
}

export function MaximizeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" />
    </svg>
  );
}

export function RestoreIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" {...props}>
      <rect x="3" y="5.2" width="7.8" height="7.8" rx="1.1" />
      <path d="M5.4 5.2V4.1A1.1 1.1 0 0 1 6.5 3h5.4A1.1 1.1 0 0 1 13 4.1v5.4a1.1 1.1 0 0 1-1.1 1.1h-1.1" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true" {...props}>
      <path d="m4 4 8 8m0-8-8 8" />
    </svg>
  );
}
