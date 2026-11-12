import Image, { type ImageProps } from "next/image";

interface RemoteIconProps extends Omit<ImageProps, "src" | "alt" | "width" | "height"> {
  src: string;
  alt: string;
  size?: number;
}

export function RemoteIcon({ src, alt, size = 24, className, ...props }: RemoteIconProps) {
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={className}
      {...props}
    />
  );
}
