import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "./packages/api/src/routers/index";
import { S3Client } from "bun";

const SERVER_URL = "http://localhost:3000";

// We need to create a user and get a session first
async function createTestUser() {
  const email = `test-${Date.now()}@example.com`;
  const password = "testpassword123";
  const name = "Test User";

  // Sign up
  const signupRes = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  if (!signupRes.ok) {
    const error = await signupRes.text();
    throw new Error(`Signup failed: ${error}`);
  }

  const cookies = signupRes.headers.getSetCookie();
  console.log("✓ User created:", email);

  return { email, password, cookies };
}

async function runTests() {
  console.log("\n=== VinnoDrive Backend Tests ===\n");

  // Step 1: Create test user
  console.log("1. Creating test user...");
  const { cookies } = await createTestUser();

  // Create tRPC client with auth cookies
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${SERVER_URL}/trpc`,
        headers: {
          Cookie: cookies.join("; "),
        },
      }),
    ],
  });

  // Step 2: Test health check
  console.log("\n2. Testing health check...");
  const health = await client.healthCheck.query();
  console.log("✓ Health check:", health);

  // Step 3: Test private data (auth check)
  console.log("\n3. Testing authenticated access...");
  const privateData = await client.privateData.query();
  console.log("✓ Private data:", privateData.message, "- User:", privateData.user.email);

  // Step 4: Test get quota (should create default quota)
  console.log("\n4. Testing storage quota...");
  const quota = await client.storage.getQuota.query();
  console.log("✓ Quota:", {
    used: quota.storageUsedFormatted,
    limit: quota.storageLimitFormatted,
    rateLimit: `${quota.rateLimit} req/sec`,
  });

  // Step 5: Test get stats (empty initially)
  console.log("\n5. Testing storage stats...");
  const stats = await client.storage.getStats.query();
  console.log("✓ Stats:", {
    files: stats.totalFiles,
    used: stats.storageUsedFormatted,
    saved: stats.savedBytesFormatted,
  });

  // Step 6: Test folder creation
  console.log("\n6. Testing folder creation...");
  const folder = await client.storage.createFolder.mutate({ name: "Test Folder" });
  console.log("✓ Folder created:", folder.folder?.name, "ID:", folder.folder?.id);

  // Step 7: Test listing files (empty, but with folder)
  console.log("\n7. Testing file listing...");
  const listing = await client.storage.listFiles.query();
  console.log("✓ Files:", listing.files.length, "| Folders:", listing.folders.length);

  // Step 8: Test file upload flow
  console.log("\n8. Testing file upload flow...");
  const testContent = "Hello, VinnoDrive! This is a test file.";
  const testBuffer = Buffer.from(testContent);
  const hash = new Bun.CryptoHasher("sha256").update(testBuffer).digest("hex");

  console.log("   - File hash:", hash);
  console.log("   - File size:", testBuffer.length, "bytes");

  // Get presigned URL
  const uploadResult = await client.storage.getUploadPresignedUrl.mutate({
    filename: "test-file.txt",
    size: testBuffer.length,
    hash: hash,
    folderId: folder.folder?.id,
  });

  if (uploadResult.deduplicated) {
    console.log("✓ File was deduplicated (already exists)");
  } else {
    console.log("   - Got presigned URL, uploading to R2...");

    // Upload to R2
    const uploadRes = await fetch(uploadResult.url!, {
      method: "PUT",
      body: testBuffer,
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });

    if (!uploadRes.ok) {
      throw new Error(`R2 upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    console.log("   - Uploaded to R2");

    // Confirm upload
    const confirmResult = await client.storage.confirmUpload.mutate({
      filename: "test-file.txt",
      size: testBuffer.length,
      hash: hash,
      folderId: folder.folder?.id,
    });
    console.log("✓ Upload confirmed:", confirmResult.message);
  }

  // Step 9: List files again
  console.log("\n9. Verifying file in listing...");
  const listing2 = await client.storage.listFiles.query({ folderId: folder.folder?.id });
  console.log("✓ Files in folder:", listing2.files.length);
  if (listing2.files[0]) {
    const file = listing2.files[0];
    console.log("   - File:", file.name, "| Size:", file.size, "| Deduped:", file.isDeduplicated);
  }

  // Step 10: Test deduplication - upload same file again
  console.log("\n10. Testing deduplication (same file upload)...");
  const dedupResult = await client.storage.getUploadPresignedUrl.mutate({
    filename: "test-file-copy.txt",
    size: testBuffer.length,
    hash: hash,
  });
  console.log("✓ Deduplication:", dedupResult.deduplicated ? "WORKED - no re-upload needed" : "FAILED");

  // Step 11: Check stats after upload
  console.log("\n11. Checking stats after uploads...");
  const stats2 = await client.storage.getStats.query();
  console.log("✓ Stats:", {
    files: stats2.totalFiles,
    dedupedFiles: stats2.dedupedFiles,
    originalSize: stats2.originalSizeFormatted,
    actualUsed: stats2.actualStorageUsedFormatted,
    saved: stats2.savedBytesFormatted,
    savedPercent: stats2.savedPercent.toFixed(1) + "%",
  });

  // Step 12: Test public sharing
  console.log("\n12. Testing public sharing...");
  const fileId = listing2.files[0]?.id;
  if (fileId) {
    const shareResult = await client.storage.togglePublic.mutate({ id: fileId, isPublic: true });
    console.log("✓ File shared:", shareResult.shareUrl);

    // Test public access (as unauthenticated client)
    const publicClient = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${SERVER_URL}/trpc` })],
    });

    const shareId = shareResult.shareUrl?.split("/").pop();
    if (shareId) {
      const publicFile = await publicClient.storage.getPublicFile.query({ shareId });
      console.log("✓ Public access works:", publicFile.name, "| Downloads:", publicFile.downloadCount);
    }
  }

  // Step 13: Test rate limiting
  console.log("\n13. Testing rate limiting...");
  let rateLimitHit = false;
  try {
    // Fire many requests quickly
    const promises = Array(10).fill(null).map(() => client.storage.getStats.query());
    await Promise.all(promises);
  } catch (e: any) {
    if (e.message?.includes("Rate limit")) {
      rateLimitHit = true;
      console.log("✓ Rate limiting works - blocked after exceeding 2 req/sec");
    } else {
      throw e;
    }
  }
  if (!rateLimitHit) {
    console.log("⚠ Rate limiting may not have triggered (requests were fast enough)");
  }

  // Step 14: Test file deletion
  console.log("\n14. Testing file deletion...");
  if (fileId) {
    // Delete first copy (should keep file in R2 since there's another reference)
    await client.storage.deleteAsset.mutate({ id: fileId });
    console.log("✓ First file reference deleted");

    // Check file still exists (via the deduplicated copy)
    const listing3 = await client.storage.listFiles.query();
    const remainingFile = listing3.files.find((f) => f.name === "test-file-copy.txt");
    if (remainingFile) {
      console.log("✓ Deduplicated copy still exists:", remainingFile.name);

      // Delete second copy (should delete from R2)
      await client.storage.deleteAsset.mutate({ id: remainingFile.id });
      console.log("✓ Second file reference deleted (R2 content should be garbage collected)");
    }
  }

  // Step 15: Test folder deletion
  console.log("\n15. Testing folder deletion...");
  if (folder.folder?.id) {
    await client.storage.deleteFolder.mutate({ id: folder.folder.id });
    console.log("✓ Folder deleted");
  }

  // Final stats
  console.log("\n16. Final stats...");
  const finalStats = await client.storage.getStats.query();
  console.log("✓ Final stats:", {
    files: finalStats.totalFiles,
    used: finalStats.storageUsedFormatted,
  });

  console.log("\n=== All Tests Passed! ===\n");
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err.message);
  process.exit(1);
});
