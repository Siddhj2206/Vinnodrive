import { Cloud } from "lucide-react";

import { Progress } from "@/components/ui/progress";

interface StorageCardProps {
  used: number;
  limit: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function StorageCard({ used, limit }: StorageCardProps) {
  const percentage = Math.min((used / limit) * 100, 100);
  const isNearLimit = percentage >= 80;
  const isOverLimit = percentage >= 95;

  return (
    <div className="bg-sidebar-accent/50 rounded-lg p-3">
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Storage</span>
      </div>
      <Progress
        value={percentage}
        className={`h-2 ${isOverLimit ? "[&>div]:bg-destructive" : isNearLimit ? "[&>div]:bg-yellow-500" : ""}`}
      />
      <div className="text-muted-foreground mt-2 text-xs">
        {formatBytes(used)} of {formatBytes(limit)} used
      </div>
      {isNearLimit && !isOverLimit && (
        <div className="mt-1 text-xs text-yellow-600 dark:text-yellow-500">
          Running low on storage
        </div>
      )}
      {isOverLimit && (
        <div className="text-destructive mt-1 text-xs">
          Storage almost full
        </div>
      )}
    </div>
  );
}
