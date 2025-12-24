import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, X, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { StorageInvalidations } from "@/utils/invalidate";
import { useTRPC } from "@/utils/trpc";

interface UploadFile {
  id: string;
  file: File;
  status: "pending" | "hashing" | "uploading" | "success" | "error" | "deduplicated";
  progress: number;
  hash?: string;
  error?: string;
}

interface FileUploadProps {
  folderId?: string;
  onComplete?: () => void;
}

async function computeSHA256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

export function FileUpload({ folderId, onComplete }: FileUploadProps) {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const getUploadUrlMutation = useMutation(
    trpc.storage.getUploadPresignedUrl.mutationOptions()
  );

  const confirmUploadMutation = useMutation(
    trpc.storage.confirmUpload.mutationOptions()
  );

  const processFile = useCallback(
    async (uploadFile: UploadFile) => {
      const { id, file } = uploadFile;

      try {
        // Update status to hashing
        setFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, status: "hashing", progress: 0 } : f))
        );

        // Compute SHA-256 hash
        const hash = await computeSHA256(file);

        setFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, hash, progress: 30 } : f))
        );

        // Request presigned URL
        const result = await getUploadUrlMutation.mutateAsync({
          filename: file.name,
          size: file.size,
          hash,
          folderId,
          contentType: file.type || "application/octet-stream",
        });

        if (result.deduplicated) {
          // File already exists, no upload needed
          setFiles((prev) =>
            prev.map((f) =>
              f.id === id
                ? { ...f, status: "deduplicated", progress: 100 }
                : f
            )
          );
          toast.success(`"${file.name}" was deduplicated (already exists)`);
        } else if (result.url) {
          // Upload to S3
          setFiles((prev) =>
            prev.map((f) =>
              f.id === id ? { ...f, status: "uploading", progress: 50 } : f
            )
          );

          const uploadResponse = await fetch(result.url, {
            method: "PUT",
            body: file,
            headers: {
              "Content-Type": file.type || "application/octet-stream",
            },
          });

          if (!uploadResponse.ok) {
            throw new Error("Failed to upload file to storage");
          }

          setFiles((prev) =>
            prev.map((f) => (f.id === id ? { ...f, progress: 80 } : f))
          );

          // Confirm upload
          await confirmUploadMutation.mutateAsync({
            filename: file.name,
            size: file.size,
            hash,
            folderId,
            contentType: file.type || "application/octet-stream",
          });

          setFiles((prev) =>
            prev.map((f) =>
              f.id === id ? { ...f, status: "success", progress: 100 } : f
            )
          );
          toast.success(`"${file.name}" uploaded successfully`);
        }

        // Invalidate relevant queries after successful upload
        StorageInvalidations.afterUpload(queryClient);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Upload failed";
        setFiles((prev) =>
          prev.map((f) =>
            f.id === id ? { ...f, status: "error", error: errorMessage } : f
          )
        );
        toast.error(`Failed to upload "${file.name}": ${errorMessage}`);
      }
    },
    [folderId, getUploadUrlMutation, confirmUploadMutation, queryClient]
  );

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const newFiles: UploadFile[] = Array.from(fileList).map((file) => ({
        id: crypto.randomUUID(),
        file,
        status: "pending" as const,
        progress: 0,
      }));

      setFiles((prev) => [...prev, ...newFiles]);

      // Process files sequentially to avoid rate limiting
      newFiles.reduce(async (prevPromise, uploadFile) => {
        await prevPromise;
        await processFile(uploadFile);
      }, Promise.resolve());
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files);
      }
      // Reset input
      e.target.value = "";
    },
    [handleFiles]
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setFiles((prev) =>
      prev.filter(
        (f) => f.status !== "success" && f.status !== "deduplicated"
      )
    );
    onComplete?.();
  }, [onComplete]);

  const hasCompletedFiles = files.some(
    (f) => f.status === "success" || f.status === "deduplicated"
  );

  return (
    <div className="space-y-4 overflow-hidden">
      {/* Drop Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        }`}
      >
        <Upload className="text-muted-foreground mx-auto mb-4 h-10 w-10" />
        <p className="text-muted-foreground mb-2 text-sm">
          Drag and drop files here, or
        </p>
        <label>
          <input
            type="file"
            multiple
            onChange={handleFileInput}
            className="hidden"
          />
          <Button variant="outline" asChild>
            <span className="cursor-pointer">Browse Files</span>
          </Button>
        </label>
        <p className="text-muted-foreground mt-2 text-xs">
          Files are automatically deduplicated using SHA-256 hashing
        </p>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2 overflow-hidden">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              Uploads ({files.length})
            </h4>
            {hasCompletedFiles && (
              <Button variant="ghost" size="sm" onClick={clearCompleted}>
                Clear Completed
              </Button>
            )}
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto overflow-x-hidden">
            {files.map((uploadFile) => (
              <div
                key={uploadFile.id}
                className="bg-muted/50 flex items-center gap-3 rounded-lg p-3 min-w-0"
              >
                {/* Status Icon */}
                <div className="flex-shrink-0">
                  {uploadFile.status === "success" && (
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  )}
                  {uploadFile.status === "deduplicated" && (
                    <CheckCircle className="h-5 w-5 text-orange-500" />
                  )}
                  {uploadFile.status === "error" && (
                    <AlertCircle className="text-destructive h-5 w-5" />
                  )}
                  {(uploadFile.status === "pending" ||
                    uploadFile.status === "hashing" ||
                    uploadFile.status === "uploading") && (
                    <Loader2 className="text-primary h-5 w-5 animate-spin" />
                  )}
                </div>

                {/* File Info */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  <p className="truncate text-sm font-medium">
                    {uploadFile.file.name}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-muted-foreground text-xs">
                      {(uploadFile.file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                    {uploadFile.status === "hashing" && (
                      <span className="text-xs text-blue-500">
                        Computing hash...
                      </span>
                    )}
                    {uploadFile.status === "uploading" && (
                      <span className="text-xs text-blue-500">
                        Uploading...
                      </span>
                    )}
                    {uploadFile.status === "deduplicated" && (
                      <span className="text-xs text-orange-500">
                        Deduplicated
                      </span>
                    )}
                    {uploadFile.status === "error" && (
                      <span className="text-destructive text-xs truncate max-w-[150px]">
                        {uploadFile.error}
                      </span>
                    )}
                  </div>
                  {(uploadFile.status === "hashing" ||
                    uploadFile.status === "uploading") && (
                    <Progress
                      value={uploadFile.progress}
                      className="mt-1 h-1"
                    />
                  )}
                </div>

                {/* Remove Button */}
                {(uploadFile.status === "success" ||
                  uploadFile.status === "deduplicated" ||
                  uploadFile.status === "error") && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 flex-shrink-0"
                    onClick={() => removeFile(uploadFile.id)}
                    aria-label="Remove file"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
