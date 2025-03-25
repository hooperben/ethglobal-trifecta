"use client";

import ThemeToggle from "@/components/theme-toggle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { retrieveMnemonic } from "@/lib/passkey";
import { useState } from "react";

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExportAccount = async () => {
    try {
      setError(null);
      // This will trigger the passkey authentication
      const retrievedMnemonic = await retrieveMnemonic();

      if (retrievedMnemonic) {
        setMnemonic(retrievedMnemonic);
        setIsModalOpen(true);
      } else {
        setError(
          "Could not retrieve your account information. Make sure you have a registered passkey.",
        );
      }
    } catch (err) {
      console.error("Export account error:", err);
      setError("Failed to authenticate with passkey.");
    }
  };

  return (
    <div className="flex flex-col w-full p-6 gap-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-primary">Account Settings</h2>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          <p>Export your secret phrase.</p>
          <Button className="max-w-[200px]" onClick={handleExportAccount}>
            Export Account
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">Theme Settings</h2>

        <ThemeToggle />
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your Secret Recovery Phrase</DialogTitle>
            <DialogDescription>
              Keep this phrase safe and secure. Anyone with this phrase can
              access your account.
            </DialogDescription>
          </DialogHeader>

          <div className="p-4 bg-secondary/20 rounded-md my-4 break-all font-mono">
            {mnemonic}
          </div>

          <DialogFooter className="flex justify-between items-center">
            <Button
              variant="outline"
              onClick={() => {
                if (mnemonic) {
                  navigator.clipboard.writeText(mnemonic);
                }
              }}
            >
              Copy to Clipboard
            </Button>
            <Button onClick={() => setIsModalOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
