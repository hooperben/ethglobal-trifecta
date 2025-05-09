"use client";

import type React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { erc20ABI } from "@/const/erc20-abi";
import { RPC_URL } from "@/const/rpc";
import { USDC_ADDRESS } from "@/const/supported-assets";
import { useAccountsData } from "@/hooks/use-accounts-data";
import { toast } from "@/hooks/use-toast";
import { useTokenBalances } from "@/hooks/use-token-balances";
import { retrieveMnemonic } from "@/lib/passkey";
import { useQuery } from "@tanstack/react-query";
import { ethers, parseEther, parseUnits } from "ethers";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface SendTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountType: "public" | "private";
}

export function SendTransactionDialog({
  open,
  onOpenChange,
  accountType,
}: SendTransactionDialogProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<"ETH" | "USDC">("USDC");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accountsData } = useAccountsData();
  const { data: tokenBalances } = useTokenBalances(accountsData);

  const { data: gasEstimate, isLoading: isLoadingGasEstimate } = useQuery({
    queryKey: [recipient, amount, selectedAsset],
    queryFn: async () => {
      if (!recipient || !amount || parseFloat(amount) <= 0) return null;

      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);

        if (selectedAsset === "ETH") {
          // Estimate gas for ETH transfer without requiring a signer
          const gasEstimate = await provider.estimateGas({
            to: recipient,
            value: parseEther(amount),
          });
          return gasEstimate;
        } else {
          // For USDC, use a static call to estimate gas
          const erc20Interface = new ethers.Interface(erc20ABI);
          const callData = erc20Interface.encodeFunctionData("transfer", [
            recipient,
            parseUnits(amount, 6),
          ]);

          const gasEstimate = await provider.estimateGas({
            to: USDC_ADDRESS,
            data: callData,
          });
          return gasEstimate;
        }
      } catch (error) {
        console.error("Gas estimation error:", error);
        return null;
      }
    },
    enabled: Boolean(recipient && amount && parseFloat(amount) > 0),
  });

  // Check if amount exceeds available balance
  const isAmountValid = useCallback(() => {
    if (!tokenBalances || !amount || parseFloat(amount) <= 0) return false;

    const availableBalance =
      selectedAsset === "ETH"
        ? parseFloat(tokenBalances?.eth || "0")
        : parseFloat(tokenBalances?.usdc || "0");

    return parseFloat(amount) <= availableBalance;
  }, [amount, selectedAsset, tokenBalances]);

  // Get gas cost in ETH
  const { data: gasCost, isLoading: isLoadingGasCost } = useQuery({
    queryKey: ["gasCost", recipient, amount, selectedAsset],
    queryFn: async () => {
      if (!gasEstimate) return null;

      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || parseUnits("10", "gwei"); // Fallback gas price

        return ethers.formatEther(gasPrice * gasEstimate);
      } catch (error) {
        console.error("Gas cost calculation error:", error);
        return null;
      }
    },
    enabled: gasEstimate !== null && gasEstimate !== undefined,
  });

  // Check if user can afford gas
  const canAffordGas = useCallback(() => {
    if (!gasCost || !tokenBalances) return true; // Assume they can if we don't know yet
    const ethBalance = parseFloat(tokenBalances.eth || "0");

    // If sending ETH, check if amount + gas < total balance
    if (selectedAsset === "ETH") {
      return parseFloat(amount) + parseFloat(gasCost) <= ethBalance;
    }

    // If sending USDC, just check if gas < eth balance
    return parseFloat(gasCost) <= ethBalance;
  }, [amount, gasCost, selectedAsset, tokenBalances]);

  // Form validation
  const isFormValid = () => {
    return (
      recipient.startsWith("0x") &&
      recipient.length === 42 &&
      amount &&
      parseFloat(amount) > 0 &&
      isAmountValid() &&
      canAffordGas()
    );
  };

  // Update error message when inputs change
  useEffect(() => {
    if (!recipient || !amount) {
      setError(null);
      return;
    }

    if (!recipient.startsWith("0x") || recipient.length !== 42) {
      setError("Invalid Ethereum address");
    } else if (parseFloat(amount) <= 0) {
      setError("Amount must be greater than 0");
    } else if (!isAmountValid()) {
      setError(`Insufficient ${selectedAsset} balance`);
    } else if (!canAffordGas()) {
      setError("Insufficient ETH for gas fees");
    } else {
      setError(null);
    }
  }, [
    recipient,
    amount,
    selectedAsset,
    tokenBalances,
    gasCost,
    canAffordGas,
    isAmountValid,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isFormValid()) {
      return;
    }

    setIsPending(true);

    try {
      const mnemonic = await retrieveMnemonic();

      if (!mnemonic) {
        throw new Error("Failed");
      }

      const userToast = toast({
        title: "Submitting Tx",
      });

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const signer = ethers.Wallet.fromPhrase(mnemonic, provider);

      let tx;

      if (selectedAsset === "ETH") {
        tx = await signer.sendTransaction({
          to: recipient,
          value: parseEther(amount),
        });
      } else {
        const erc20 = new ethers.Contract(USDC_ADDRESS, erc20ABI, signer);

        tx = await erc20.transfer(recipient, parseUnits(amount, 6));
      }

      await tx.wait(2);

      userToast.update({
        id: userToast.id,
        title: "Transaction confirmed",
      });

      // Reset form and close dialog after successful transaction
      setRecipient("");
      setAmount("");
      onOpenChange(false);
    } catch (err) {
      console.log(err);

      // Show error toast
      toast({
        title: "Transaction Failed",
        description:
          err instanceof Error ? err.message : "An unknown error occurred",
        variant: "destructive",
      });

      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>
            Send {accountType === "public" ? "Public" : "Private"} Funds
          </DialogTitle>
          <DialogDescription>
            Enter the recipient address and amount to send.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="recipient">Recipient Address</Label>
              <Input
                id="recipient"
                placeholder="0x..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label>Select Asset</Label>
              <RadioGroup
                value={selectedAsset}
                onValueChange={(value) =>
                  setSelectedAsset(value as "ETH" | "USDC")
                }
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="USDC" id="usdc" />
                  <Label htmlFor="usdc" className="cursor-pointer">
                    USDC
                    <span className="text-xs text-muted-foreground ml-1">
                      (Available: {tokenBalances?.usdc || "0"})
                    </span>
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="ETH" id="eth" />
                  <Label htmlFor="eth" className="cursor-pointer">
                    ETH
                    <span className="text-xs text-muted-foreground ml-1">
                      (Available: {tokenBalances?.eth || "0"})
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                step="any"
                min="0"
                className={!isAmountValid() && amount ? "border-red-500" : ""}
              />
            </div>
          </div>

          {isLoadingGasEstimate || isLoadingGasCost ? (
            <div className="text-sm flex items-center mt-2">
              <Loader2 className="h-3 w-3 mr-2 animate-spin" />
              Calculating transaction fee...
            </div>
          ) : gasCost ? (
            <div className="text-sm text-muted-foreground mt-2">
              Estimated gas fee: {parseFloat(gasCost).toFixed(6)} ETH
            </div>
          ) : null}

          {error && <div className="text-sm text-red-500 mt-2">{error}</div>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                isPending ||
                isLoadingGasEstimate ||
                isLoadingGasCost ||
                !isFormValid()
              }
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : isLoadingGasEstimate || isLoadingGasCost ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading...
                </>
              ) : (
                "Send"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
