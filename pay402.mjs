import { ethers } from "ethers";
import fs from "fs";
const KEY = fs.readFileSync("/home/agentuser/.swarmmemo/wallet.key", "utf8").trim();
const wallet = new ethers.Wallet(KEY);
console.log("payer:", wallet.address);
const RPC = "https://base-rpc.publicnode.com";
const prov = new ethers.JsonRpcProvider(RPC);
const walletC = wallet.connect(prov);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://compliance-api.kamajaya-agents.workers.dev/v1/ofac?name=Saddam";

// 1. ambil 402
const r0 = await fetch(RESOURCE);
const req402 = (await r0.json());
const acc = req402.accepts.find(a => a.scheme === "exact");
console.log("402 amount:", acc.amount, "payTo:", acc.payTo, "extra:", JSON.stringify(acc.extra));

// 2. EIP-712 transferWithAuthorization
const now = Math.floor(Date.now()/1000);
const auth = {
  from: wallet.address, to: acc.payTo,
  value: acc.amount,
  validAfter: now - 60,
  validBefore: now + 600,
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const domain = { name: acc.extra.name, version: acc.extra.version, chainId: 8453, verifyingContract: USDC };
const types = { TransferWithAuthorization: [
  {name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
  {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"} ]};
const sig = await walletC.signTypedData(domain, types, auth);

const payload = {
  x402Version: 2,
  resource: { url: RESOURCE, description: "self-test", mimeType: "application/json" },
  accepted: { scheme: "exact", network: "eip155:8453", amount: acc.amount, asset: USDC, payTo: acc.payTo, extra: acc.extra },
  payload: { signature: sig, authorization: {
    from: auth.from, to: auth.to, value: acc.amount,
    validAfter: String(auth.validAfter), validBefore: String(auth.validBefore), nonce: auth.nonce } }
};
const enc = Buffer.from(JSON.stringify(payload)).toString("base64url");

// 3. panggil ulang dgn PAYMENT-SIGNATURE
const r1 = await fetch(RESOURCE, { headers: { "PAYMENT-SIGNATURE": enc } });
const body = await r1.json();
console.log("status:", r1.status);
console.log(JSON.stringify(body).slice(0, 600));
