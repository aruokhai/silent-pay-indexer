import { randomBytes } from 'crypto';
import { mnemonicToSeedSync } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import {
    initEccLib,
    payments,
    Psbt,
    networks,
    Payment,
    Transaction,
} from 'bitcoinjs-lib';

initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

export class WalletHelper {
    private mnemonic: string;
    private seed: Buffer;
    private root: any;

    constructor(
        mnemonic = 'select approve zebra athlete happy whisper parrot will yellow fortune demand father',
    ) {
        this.mnemonic = mnemonic;
        this.seed = mnemonicToSeedSync(this.mnemonic);
        this.root = bip32.fromSeed(this.seed, networks.regtest);
    }

    getMnemonic(): string {
        return this.mnemonic;
    }

    generateAddresses(
        count: number,
        type: 'p2wpkh' | 'p2wsh' | 'p2tr',
    ): Payment[] {
        const outputs: Payment[] = [];
        for (let i = 0; i < count; i++) {
            const path = `m/84'/0'/0'/0/${i}`;
            const child = this.root.derivePath(path);
            let output;

            switch (type) {
                case 'p2wpkh':
                    output = payments.p2wpkh({
                        pubkey: child.publicKey,
                        network: networks.regtest,
                    });
                    break;
                case 'p2tr':
                    // const sendInternalKey = bip32.fromSeed(
                    //     rng(64),
                    //     networks.regtest,
                    // );
                    // const sendPubKey = toXOnly(sendInternalKey.publicKey);
                    output = payments.p2tr({
                        internalPubkey: toXOnly(child.publicKey),
                        network: networks.regtest,
                    });
                    break;
                default:
                    throw new Error('Unsupported address type');
            }

            outputs.push(output);
        }
        return outputs;
    }

    createWallet(): { mnemonic: string; addresses: Payment[] } {
        const addresses = this.generateAddresses(10, 'p2wpkh');
        return { mnemonic: this.mnemonic, addresses };
    }

    /**
     * Craft and sign a transaction sending 6 BTC to the provided Taproot address.
     *
     * @param utxos - Array of UTXOs to spend from.
     * @param taprootAddress - The Taproot address to send to.
     * @param fee - The fee to apply in satoshis.
     * @returns {string} The raw signed transaction hex.
     */
    craftTransaction(
        utxos: Array<{
            txid: string;
            vout: number;
            value: number;
            rawTx: string;
        }>,
        taprootOutput: Payment,
    ): Transaction {
        const psbt = new Psbt({ network: networks.regtest });

        utxos.forEach((utxo) => {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                nonWitnessUtxo: Buffer.from(utxo.rawTx, 'hex'),
            });
        });

        // Add the output to the Taproot address (6 BTC)
        const totalInputValue = utxos.reduce(
            (acc, utxo) => acc + utxo.value,
            0,
        );
        const outputValue = 5.999 * 1e8;
        const fee = 0.001 * 1e8;

        if (totalInputValue < outputValue + fee) {
            throw new Error('Insufficient funds');
        }

        console.log(taprootOutput.pubkey);
        console.log(taprootOutput.internalPubkey);
        console.log(taprootOutput.address);

        psbt.addOutput({
            address: taprootOutput.address,
            tapInternalKey: taprootOutput.internalPubkey,
            value: BigInt(outputValue),
        });

        // Sign the inputs with the corresponding private keys
        utxos.forEach((utxo, index) => {
            const child = this.root.derivePath(`m/84'/0'/0'/0/${index}`);
            const keyPair = child;
            psbt.signInput(index, keyPair);
        });

        psbt.finalizeAllInputs();

        return psbt.extractTransaction(true);
    }
}

const toXOnly = (pubKey) =>
    pubKey.length === 32 ? pubKey : pubKey.slice(1, 33);
