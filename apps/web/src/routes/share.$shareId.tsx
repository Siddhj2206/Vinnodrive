import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, File, AlertCircle, ArrowLeft, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/share/$shareId")({
  component: SharePage,
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function SharePage() {
  const { shareId } = Route.useParams();
  const trpc = useTRPC();

  const fileQuery = useQuery(
    trpc.storage.getPublicFile.queryOptions({ shareId })
  );

  const handleDownload = () => {
    if (fileQuery.data?.downloadUrl) {
      // Open download URL in new tab or trigger download
      window.open(fileQuery.data.downloadUrl, "_blank");
    }
  };

  // Loading state
  if (fileQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <Skeleton className="h-16 w-16 rounded-full mx-auto mb-4" />
            <Skeleton className="h-6 w-48 mx-auto mb-2" />
            <Skeleton className="h-4 w-32 mx-auto" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (fileQuery.isError || !fileQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <CardTitle>File Not Found</CardTitle>
            <CardDescription>
              This file doesn't exist or is no longer publicly shared.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link to="/">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Go to Homepage
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const file = fileQuery.data;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <File className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="break-all">{file.name}</CardTitle>
          <CardDescription>
            Shared via VinnoDrive
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* File Details */}
          <div className="space-y-3 rounded-lg bg-muted/50 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Size</span>
              <span className="font-medium">{formatBytes(file.size)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Uploaded</span>
              <span className="font-medium">{formatDate(file.uploadDate)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Downloads</span>
              <span className="flex items-center gap-1 font-medium">
                <Eye className="h-3.5 w-3.5" />
                {file.downloadCount}
              </span>
            </div>
          </div>

          {/* Download Button */}
          <Button onClick={handleDownload} className="w-full" size="lg">
            <Download className="mr-2 h-5 w-5" />
            Download File
          </Button>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground">
            Download links expire after 1 hour for security.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
