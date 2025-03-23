import RSA, { getPayload, SignatureGenModule } from "../helpers/rsa";
import { EncryptedMessage, KeyPair } from "../web/signature_gen";

import { UltraHonkBackend } from "@aztec/bb.js";
import { InputMap, Noir } from "@noir-lang/noir_js";
import { keccak256, parseUnits, Wallet } from "ethers";
import MerkleTree from "merkletreejs";
import { getLeafAddedDetails, getPayloadDetails } from "../helpers/logs";
import { generateZerosFunction } from "../helpers/merkle-tree";
import { generateRandomSecret } from "../helpers/random";
import { getTestingAPI, numberToUint8Array } from "../helpers/testing-api";
import { CommBankDotEth, USDC } from "../typechain-types";

const convertFromHexToArray = (rawInput: string): Uint8Array => {
  const formattedInput = rawInput.startsWith("0x")
    ? rawInput.slice(2)
    : rawInput;

  const evenFormattedInput =
    formattedInput.length % 2 === 0 ? formattedInput : "0" + formattedInput;

  return Uint8Array.from(Buffer.from(evenFormattedInput, "hex"));
};

describe("Note creation and flow testing", () => {
  let rsa: typeof SignatureGenModule;

  let backend: UltraHonkBackend;
  let noir: Noir;
  let circuit: Noir;
  let alice: Wallet;
  let bob: Wallet;
  let aliceRSA: KeyPair;
  let bobRSA: KeyPair;
  let usdc: USDC;
  let commbank: CommBankDotEth;
  let tree: MerkleTree;

  before(async () => {
    rsa = RSA();
    ({
      circuit,
      noir,
      backend,
      alice,
      bob,
      aliceRSA,
      bobRSA,
      usdc,
      commbank,
      tree,
    } = await getTestingAPI());

    await usdc.connect(alice).mint(alice.address, parseUnits("1000000", 6));
  });

  it("should let me create a key pair", async () => {
    const note = {
      secret:
        "0xc0160463fbe2d99a4f7f9ffd93a0789132980899da181cc42021488404fa7c31",
      asset: "0xF0bAfD58E23726785A1681e1DEa0da15cB038C61",
      amount: "18446744073709551615", // Maximum value for u64 in Rust (2^64 - 1)
    };

    const encryptedMessage = rsa.encrypt(
      `${note.secret}${note.asset}${note.amount}`,
      aliceRSA.public_key,
    );

    const decryptedMessage = rsa.decrypt(
      encryptedMessage,
      aliceRSA.private_key,
    );

    console.log(decryptedMessage);
  });

  it.only("should let me deposit to the contract", async () => {
    // approve commbank.eth to move USDC for the user
    await usdc
      .connect(alice)
      .approve(await commbank.getAddress(), parseUnits("1000000", 6));

    const depositAmount = 69_420n;

    // Create a proper big-endian byte array from the number
    const amount = numberToUint8Array(depositAmount); // new Uint8Array(32);

    const assetId = convertFromHexToArray(await usdc.getAddress());
    const noteSecret = generateRandomSecret();

    const alicePubKey = convertFromHexToArray(
      keccak256(keccak256(aliceRSA.private_key)),
    );

    const noteHash = keccak256(
      Uint8Array.from([...alicePubKey, ...amount, ...assetId, ...noteSecret]),
    );

    const input = {
      note_secret: Array.from(noteSecret).map((item) => item.toString()),
      hash: Array.from(convertFromHexToArray(noteHash)).map((item) =>
        item.toString(),
      ),
      amount: depositAmount.toString(), // Convert bigint to number for Noir
      amount_array: Array.from(amount).map((item) => item.toString()),
      // pub key is keccak(keccak(rsa.private_key))
      pub_key: Array.from(alicePubKey).map((item) => item.toString()),
      asset_id: Array.from(assetId).map((item) => item.toString()),
    };

    // console.log(`let note_hash = [${convertFromHexToArray(noteHash)}];`);
    // console.log(`let note_secret = [${input.note_secret}];`);

    const { witness } = await noir.execute(input as unknown as InputMap);

    const { proof, publicInputs } = await backend.generateProof(witness, {
      keccak: true,
    });

    const payload = getPayload(noteSecret, assetId, amount);
    const encryptedMessage = rsa.encrypt(payload, aliceRSA.public_key);

    const tx = await commbank
      .connect(alice)
      .deposit(
        await usdc.getAddress(),
        69420n,
        proof.slice(4),
        publicInputs,
        encryptedMessage.data,
      );

    // Wait for transaction to be mined and get receipt
    const receipt = await tx.wait();

    const leafDetails = getLeafAddedDetails(commbank, receipt!.logs);
    const encryptedBytes = getPayloadDetails(commbank, receipt!.logs);

    const uint8ArrayEncryptedBytes = convertFromHexToArray(
      encryptedBytes.payload,
    );

    const parsedEncrypted = new EncryptedMessage(uint8ArrayEncryptedBytes);

    const decryptedMessage = rsa.decrypt(parsedEncrypted, aliceRSA.private_key);

    console.log("decryptedMessage: ", decryptedMessage);
    console.log("payload: ", payload);

    // update our tree with the inserted note
    tree.updateLeaf(leafDetails.leafIndex, leafDetails.noteHash);

    const merklePath = tree.getProof(noteHash).map((step) => {
      return {
        path: step.position === "right" ? 1 : 0,
        value: convertFromHexToArray(step.data.toString("hex")),
      };
    });

    const paths = merklePath.map((x) => x.path);
    const values = merklePath.map((x) => [x.value]);

    const inputNote = {
      owner: alicePubKey,
      owner_secret: convertFromHexToArray(keccak256(aliceRSA.private_key)),
      note_secret: noteSecret,
      asset_id: assetId,
      amount_array: amount,
      amount: depositAmount.toString(),
      leaf_index: numberToUint8Array(leafDetails.leafIndex),
      path: paths,
      path_data: values,
    };

    const inputNoteNullifier = keccak256(
      Uint8Array.from([
        ...inputNote.leaf_index,
        ...inputNote.note_secret,
        ...inputNote.amount_array,
        ...inputNote.asset_id,
      ]),
    );

    // we are sending bob 420 tokens. Alice should have 69000 left over
    const aliceOutputNote = {
      owner: alicePubKey,
      secret: generateRandomSecret(),
      asset_id: assetId,
      amount_array: numberToUint8Array(69000n),
      amount: 69000,
    };

    const aliceOutputNoteHash = convertFromHexToArray(
      keccak256(
        Uint8Array.from([
          ...alicePubKey,
          ...aliceOutputNote.amount_array,
          ...assetId,
          ...aliceOutputNote.secret,
        ]),
      ),
    );

    const bobPubKey = convertFromHexToArray(
      keccak256(keccak256(aliceRSA.private_key)),
    );

    const bobOutputNote = {
      owner: Array.from(bobPubKey),
      secret: generateRandomSecret(),
      asset_id: assetId,
      amount_array: numberToUint8Array(420n),
      amount: 420,
    };

    const bobOutputNoteHash = convertFromHexToArray(
      keccak256(
        Uint8Array.from([
          ...bobPubKey,
          ...bobOutputNote.amount_array,
          ...assetId,
          ...bobOutputNote.secret,
        ]),
      ),
    );

    const transactInput = {
      root: convertFromHexToArray("0x" + tree.getRoot().toString("hex")),
      input_notes: [inputNote],
      output_notes: [aliceOutputNote, bobOutputNote],
      nullifiers: [convertFromHexToArray(inputNoteNullifier)],
      output_hashes: [aliceOutputNoteHash, bobOutputNoteHash],
    };

    console.log(
      `let root = [${transactInput.root.map((item) => Number(item))}];`,
    );
    console.log(
      `let alice_input_note: InputNote = InputNote {
        owner: [${Array.from(inputNote.owner).map((n) => n)}],
        owner_secret: [${Array.from(inputNote.owner_secret).map((n) => n)}],
        note_secret: [${Array.from(inputNote.note_secret).map((n) => n)}],
        asset_id: [${Array.from(inputNote.asset_id).map((n) => n)}],
        amount_array: [${Array.from(inputNote.amount_array).map((n) => n)}],
        amount: ${inputNote.amount},
        leaf_index: [${Array.from(inputNote.leaf_index).map((n) => n)}],
        path: [${inputNote.path.join(", ")}],
        path_data: [[${inputNote.path_data
          .map((array) => array.join(", "))
          .join("], [")}]],
      };`,
    );

    console.log(
      `let alice_output_note: OutputNote = OutputNote {
        owner: [${Array.from(aliceOutputNote.owner).map((n) => n)}],
        note_secret: [${Array.from(aliceOutputNote.secret).map((n) => n)}],
        asset_id: [${Array.from(aliceOutputNote.asset_id).map((n) => n)}],
        amount_array: [${Array.from(aliceOutputNote.amount_array).map(
          (n) => n,
        )}],
        amount: ${aliceOutputNote.amount},
      };`,
    );

    console.log(
      `let bob_output_note: OutputNote = OutputNote {
        owner: [${bobOutputNote.owner.join(", ")}],
        note_secret: [${Array.from(bobOutputNote.secret).map((n) => n)}],
        asset_id: [${Array.from(bobOutputNote.asset_id).map((n) => n)}],
        amount_array: [${Array.from(bobOutputNote.amount_array).map((n) => n)}],
        amount: ${bobOutputNote.amount},
      };`,
    );

    console.log(
      `let alice_nullifier = [${transactInput.nullifiers[0].map((item) =>
        Number(item),
      )}];`,
    );
    console.log(
      `let alice_output_hash = [${transactInput.output_hashes[0].map((item) =>
        Number(item),
      )}];`,
    );
    console.log(
      `let bob_output_hash = [${transactInput.output_hashes[1].map((item) =>
        Number(item),
      )}];`,
    );
  });

  it.skip("should output sol code for zeros() in merkle tree", async () => {
    generateZerosFunction();
  });
});
