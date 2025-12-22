import { useQuery } from "@tanstack/react-query";
import { Download, File, Loader2, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTRPC } from "@/utils/trpc";

interface FilePreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: {
    id: string;
    name: string;
    size: number;
    contentType: string | null;
  } | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function getPreviewType(contentType: string | null): "image" | "video" | "audio" | "pdf" | "text" | "none" {
  if (!contentType) return "none";
  
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("text/") || 
      contentType === "application/json" ||
      contentType === "application/javascript" ||
      contentType === "application/xml") return "text";
  
  return "none";
}

function FilePreviewContent({ 
  contentType, 
  downloadUrl, 
  fileName 
}: { 
  contentType: string | null; 
  downloadUrl: string;
  fileName: string;
}) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  
  const previewType = getPreviewType(contentType);
  
  // Load text content if needed
  const loadTextContent = async () => {
    if (textContent !== null || textLoading) return;
    
    setTextLoading(true);
    setTextError(null);
    
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error("Failed to fetch file");
      
      const text = await response.text();
      // Limit text preview to first 50KB
      setTextContent(text.slice(0, 50000) + (text.length > 50000 ? "\n\n... (truncated)" : ""));
    } catch (err) {
      setTextError(err instanceof Error ? err.message : "Failed to load text content");
    } finally {
      setTextLoading(false);
    }
  };
  
  // Load text content on mount if it's a text file
  if (previewType === "text" && textContent === null && !textLoading && !textError) {
    loadTextContent();
  }
  
  switch (previewType) {
    case "image":
      return (
        <div className="flex items-center justify-center max-h-[70vh] overflow-hidden">
          <img 
            src={downloadUrl} 
            alt={fileName}
            className="max-w-full max-h-[70vh] object-contain rounded-md"
          />
        </div>
      );
      
    case "video":
      return (
        <div className="flex items-center justify-center">
          <video 
            controls 
            className="max-w-full max-h-[70vh] rounded-md"
            preload="metadata"
          >
            <source src={downloadUrl} type={contentType || undefined} />
            Your browser does not support video playback.
          </video>
        </div>
      );
      
    case "audio":
      return (
        <div className="flex flex-col items-center justify-center py-8 gap-4">
          <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center">
            <File className="h-12 w-12 text-muted-foreground" />
          </div>
          <audio controls className="w-full max-w-md">
            <source src={downloadUrl} type={contentType || undefined} />
            Your browser does not support audio playback.
          </audio>
        </div>
      );
      
    case "pdf":
      return (
        <div className="h-[70vh] w-full">
          <iframe
            src={downloadUrl}
            className="w-full h-full rounded-md border"
            title={fileName}
          />
        </div>
      );
      
    case "text":
      if (textLoading) {
        return (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        );
      }
      
      if (textError) {
        return (
          <div className="text-center py-12">
            <p className="text-destructive">{textError}</p>
          </div>
        );
      }
      
      return (
        <div className="max-h-[70vh] overflow-auto">
          <pre className="text-sm bg-muted p-4 rounded-md whitespace-pre-wrap break-words font-mono">
            {textContent}
          </pre>
        </div>
      );
      
    default:
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center">
            <File className="h-12 w-12 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground text-center">
            Preview not available for this file type
            {contentType && <span className="block text-xs mt-1">({contentType})</span>}
          </p>
        </div>
      );
  }
}

export function FilePreviewModal({ open, onOpenChange, file }: FilePreviewModalProps) {
  const trpc = useTRPC();
  
  // Fetch file details including download URL
  const fileQuery = useQuery({
    ...trpc.storage.getFile.queryOptions({ id: file?.id || "" }),
    enabled: open && !!file?.id,
  });
  
  const handleDownload = () => {
    if (fileQuery.data?.downloadUrl) {
      window.open(fileQuery.data.downloadUrl, "_blank");
    }
  };
  
  const handleOpenInNewTab = () => {
    if (fileQuery.data?.downloadUrl) {
      window.open(fileQuery.data.downloadUrl, "_blank");
    }
  };
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between pr-8">
            <div className="flex-1 min-w-0">
              <DialogTitle className="truncate">{file?.name}</DialogTitle>
              {file && (
                <p className="text-sm text-muted-foreground mt-1">
                  {formatBytes(file.size)}
                  {file.contentType && ` - ${file.contentType}`}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenInNewTab}
                disabled={!fileQuery.data?.downloadUrl}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Open
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleDownload}
                disabled={!fileQuery.data?.downloadUrl}
              >
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            </div>
          </div>
        </DialogHeader>
        
        <div className="flex-1 overflow-hidden mt-4">
          {fileQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : fileQuery.error ? (
            <div className="text-center py-12">
              <p className="text-destructive">Failed to load file</p>
            </div>
          ) : fileQuery.data ? (
            <FilePreviewContent
              contentType={file?.contentType || null}
              downloadUrl={fileQuery.data.downloadUrl}
              fileName={file?.name || ""}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Simplified preview modal for public share pages (uses different query)
interface PublicFilePreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: {
    name: string;
    size: number;
    contentType: string | null;
    downloadUrl: string;
  } | null;
}

export function PublicFilePreview({ open, onOpenChange, file }: PublicFilePreviewProps) {
  const handleDownload = () => {
    if (file?.downloadUrl) {
      window.open(file.downloadUrl, "_blank");
    }
  };
  
  const handleOpenInNewTab = () => {
    if (file?.downloadUrl) {
      window.open(file.downloadUrl, "_blank");
    }
  };
  
  if (!file) return null;
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between pr-8">
            <div className="flex-1 min-w-0">
              <DialogTitle className="truncate">{file.name}</DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {formatBytes(file.size)}
                {file.contentType && ` - ${file.contentType}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenInNewTab}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Open
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleDownload}
              >
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            </div>
          </div>
        </DialogHeader>
        
        <div className="flex-1 overflow-hidden mt-4">
          <FilePreviewContent
            contentType={file.contentType}
            downloadUrl={file.downloadUrl}
            fileName={file.name}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
