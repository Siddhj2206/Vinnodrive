import { useQuery } from "@tanstack/react-query";
import { File, FileText, FileImage, FileVideo, FileAudio, FileArchive } from "lucide-react";
import { useState } from "react";

import { useTRPC } from "@/utils/trpc";
import { cn } from "@/lib/utils";

interface FileThumbnailProps {
  fileId: string;
  fileName: string;
  contentType: string | null;
  className?: string;
}

function getFileIcon(contentType: string | null) {
  if (!contentType) return File;
  
  if (contentType.startsWith("image/")) return FileImage;
  if (contentType.startsWith("video/")) return FileVideo;
  if (contentType.startsWith("audio/")) return FileAudio;
  if (contentType.startsWith("text/") || 
      contentType === "application/json" ||
      contentType === "application/javascript" ||
      contentType === "application/xml") return FileText;
  if (contentType.includes("zip") || 
      contentType.includes("tar") || 
      contentType.includes("rar") ||
      contentType.includes("compressed")) return FileArchive;
  if (contentType === "application/pdf") return FileText;
  
  return File;
}

function shouldShowThumbnail(contentType: string | null): boolean {
  if (!contentType) return false;
  
  // Only show thumbnails for images, videos, and PDFs
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType === "application/pdf"
  );
}

export function FileThumbnail({ fileId, fileName, contentType, className }: FileThumbnailProps) {
  const trpc = useTRPC();
  const [imageError, setImageError] = useState(false);
  const showThumbnail = shouldShowThumbnail(contentType) && !imageError;
  
  // Only fetch if we're going to show a thumbnail
  const fileQuery = useQuery({
    ...trpc.storage.getFile.queryOptions({ id: fileId }),
    enabled: showThumbnail,
    staleTime: 1000 * 60 * 30, // Cache for 30 minutes
  });
  
  const Icon = getFileIcon(contentType);
  
  // Show icon if not a thumbnail type, still loading, error, or image failed to load
  if (!showThumbnail || fileQuery.isLoading || fileQuery.isError || !fileQuery.data?.downloadUrl) {
    return (
      <div className={cn(
        "flex items-center justify-center rounded bg-muted",
        className || "h-8 w-8"
      )}>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  
  const downloadUrl = fileQuery.data.downloadUrl;
  
  // For images
  if (contentType?.startsWith("image/")) {
    return (
      <div className={cn(
        "relative overflow-hidden rounded bg-muted",
        className || "h-8 w-8"
      )}>
        <img
          src={downloadUrl}
          alt={fileName}
          className="h-full w-full object-cover"
          onError={() => setImageError(true)}
          loading="lazy"
        />
      </div>
    );
  }
  
  // For videos - show poster frame or video element
  if (contentType?.startsWith("video/")) {
    return (
      <div className={cn(
        "relative overflow-hidden rounded bg-muted",
        className || "h-8 w-8"
      )}>
        <video
          src={downloadUrl}
          className="h-full w-full object-cover"
          onError={() => setImageError(true)}
          preload="metadata"
          muted
        />
        {/* Play icon overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
          <div className="h-3 w-3 border-l-[6px] border-y-[4px] border-l-white border-y-transparent" />
        </div>
      </div>
    );
  }
  
  // For PDFs - show icon with PDF badge
  if (contentType === "application/pdf") {
    return (
      <div className={cn(
        "relative flex items-center justify-center rounded bg-red-100 dark:bg-red-900/30",
        className || "h-8 w-8"
      )}>
        <span className="text-[10px] font-bold text-red-600 dark:text-red-400">PDF</span>
      </div>
    );
  }
  
  // Fallback to icon
  return (
    <div className={cn(
      "flex items-center justify-center rounded bg-muted",
      className || "h-8 w-8"
    )}>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}
