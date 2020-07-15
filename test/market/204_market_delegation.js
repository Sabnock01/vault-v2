// External
const Vat = artifacts.require('Vat');
const GemJoin = artifacts.require('GemJoin');
const DaiJoin = artifacts.require('DaiJoin');
const Weth = artifacts.require("WETH9");
const ERC20 = artifacts.require("TestERC20");
const Jug = artifacts.require('Jug');
const Pot = artifacts.require('Pot');
const End = artifacts.require('End');
const Chai = artifacts.require('Chai');
const GasToken = artifacts.require('GasToken1');

// Common
const Treasury = artifacts.require('Treasury');

// YDai
const YDai = artifacts.require('YDai');
const Controller = artifacts.require('Controller');

// Peripheral
const EthProxy = artifacts.require('EthProxy');
const Unwind = artifacts.require('Unwind');
const Market = artifacts.require('Market');

// Mocks
const FlashMinterMock = artifacts.require('FlashMinterMock');

const truffleAssert = require('truffle-assertions');
const helper = require('ganache-time-traveler');
const { toWad, toRay, toRad, addBN, subBN, mulRay, divRay } = require('../shared/utils');
const { BN, expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
const { assert, expect } = require('chai');

contract('Market - Delegation', async (accounts) =>  {
    let [ owner, user1, operator, from, to ] = accounts;
    let vat;
    let weth;
    let wethJoin;
    let dai;
    let daiJoin;
    let jug;
    let pot;
    let end;
    let chai;
    let gasToken;
    let treasury;
    let yDai1;
    let yDai2;
    let controller;
    let splitter;
    let market;
    let flashMinter;

    let ilk = web3.utils.fromAscii("ETH-A");
    let Line = web3.utils.fromAscii("Line");
    let spotName = web3.utils.fromAscii("spot");
    let linel = web3.utils.fromAscii("line");

    const limits =  toRad(10000);
    const spot = toRay(1.2);

    const rate1 = toRay(1.4);
    const rate2 = toRay(1.82);
    const chi1 = toRay(1.2);

    const daiDebt1 = toWad(96);
    const daiTokens1 = mulRay(daiDebt1, rate1);
    const yDaiTokens1 = daiTokens1;
    const wethTokens1 = divRay(daiTokens1, spot);

    let maturity;

    // Convert eth to weth and use it to borrow `daiTokens` from MakerDAO
    // This function shadows and uses global variables, careful.
    async function getDai(user, _daiTokens){
        await vat.hope(daiJoin.address, { from: user });
        await vat.hope(wethJoin.address, { from: user });

        const _daiDebt = divRay(_daiTokens, rate1);
        const _wethTokens = divRay(_daiTokens, spot);

        await weth.deposit({ from: user, value: _wethTokens });
        await weth.approve(wethJoin.address, _wethTokens, { from: user });
        await wethJoin.join(user, _wethTokens, { from: user });
        await vat.frob(ilk, user, user, user, _wethTokens, _daiDebt, { from: user });
        await daiJoin.exit(user, _daiTokens, { from: user });
    }

    beforeEach(async() => {
        snapshot = await helper.takeSnapshot();
        snapshotId = snapshot['result'];

        // Setup vat, join and weth
        vat = await Vat.new();
        await vat.init(ilk, { from: owner }); // Set ilk rate (stability fee accumulator) to 1.0

        weth = await Weth.new({ from: owner });
        wethJoin = await GemJoin.new(vat.address, ilk, weth.address, { from: owner });

        dai = await ERC20.new(0, { from: owner });
        daiJoin = await DaiJoin.new(vat.address, dai.address, { from: owner });

        await vat.file(ilk, spotName, spot, { from: owner });
        await vat.file(ilk, linel, limits, { from: owner });
        await vat.file(Line, limits);

        // Setup jug
        jug = await Jug.new(vat.address);
        await jug.init(ilk, { from: owner }); // Set ilk duty (stability fee) to 1.0

        // Setup pot
        pot = await Pot.new(vat.address);

        // Permissions
        await vat.rely(vat.address, { from: owner });
        await vat.rely(wethJoin.address, { from: owner });
        await vat.rely(daiJoin.address, { from: owner });
        await vat.rely(jug.address, { from: owner });
        await vat.rely(pot.address, { from: owner });
        await vat.hope(daiJoin.address, { from: owner });

        // Setup chai
        chai = await Chai.new(
            vat.address,
            pot.address,
            daiJoin.address,
            dai.address,
        );

        treasury = await Treasury.new(
            vat.address,
            weth.address,
            dai.address,
            wethJoin.address,
            daiJoin.address,
            pot.address,
            chai.address,
        );
    
        // Setup yDai1
        const block = await web3.eth.getBlockNumber();
        maturity = (await web3.eth.getBlock(block)).timestamp + 31556952; // One year
        yDai1 = await YDai.new(
            vat.address,
            jug.address,
            pot.address,
            treasury.address,
            maturity,
            "Name",
            "Symbol"
        );
        await treasury.orchestrate(yDai1.address, { from: owner });

        // Setup Market
        market = await Market.new(
            dai.address,
            yDai1.address,
            { from: owner }
        );

        // Test setup
        
        // Increase the rate accumulator
        await vat.fold(ilk, vat.address, subBN(rate1, toRay(1)), { from: owner }); // Fold only the increase from 1.0
        await pot.setChi(chi1, { from: owner }); // Set the savings accumulator

        // Allow owner to mint yDai the sneaky way, without recording a debt in controller
        await yDai1.orchestrate(owner, { from: owner });

    });

    afterEach(async() => {
        await helper.revertToSnapshot(snapshotId);
    });

    describe("with liquidity", () => {
        beforeEach(async() => {
            const daiReserves = daiTokens1;
            const yDaiReserves = yDaiTokens1;
            await getDai(user1, daiReserves)
            await yDai1.mint(user1, yDaiReserves, { from: owner });
    
            await dai.approve(market.address, daiReserves, { from: user1 });
            await yDai1.approve(market.address, yDaiReserves, { from: user1 });
            await market.init(daiReserves, yDaiReserves, { from: user1 });
        });

        it("sells dai without delegation", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await getDai(from, daiTokens1);

            // yDaiOutForChaiIn formula: https://www.desmos.com/calculator/dcjuj5lmmc

            assert.equal(
                await yDai1.balanceOf(to),
                0,
                "'To' wallet should have no yDai, instead has " + await yDai1.balanceOf(operator),
            );

            await dai.approve(market.address, oneToken, { from: from });
            await market.sellDai(from, to, oneToken, { from: from });

            assert.equal(
                await dai.balanceOf(from),
                daiTokens1.sub(oneToken).toString(),
                "'From' wallet should have " + daiTokens1.sub(oneToken) + " dai tokens",
            );

            const expectedYDaiOut = (new BN(oneToken.toString())).mul(new BN('99814')).div(new BN('100000')); // I just hate javascript
            const yDaiOut = new BN(await yDai1.balanceOf(to));
            expect(yDaiOut).to.be.bignumber.gt(expectedYDaiOut.mul(new BN('9999')).div(new BN('10000')));
            expect(yDaiOut).to.be.bignumber.lt(expectedYDaiOut.mul(new BN('10001')).div(new BN('10000')));
        });

        it("buys dai without delegation", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await yDai1.mint(from, yDaiTokens1, { from: owner });

            // yDaiInForChaiOut formula: https://www.desmos.com/calculator/16c4dgxhst

            assert.equal(
                await yDai1.balanceOf(from),
                yDaiTokens1.toString(),
                "'From' wallet should have " + yDaiTokens1 + " yDai, instead has " + await yDai1.balanceOf(from),
            );

            await yDai1.approve(market.address, yDaiTokens1, { from: from });
            await market.buyDai(from, to, oneToken, { from: from });

            assert.equal(
                await dai.balanceOf(to),
                oneToken.toString(),
                "Receiver account should have 1 dai token",
            );

            const expectedYDaiIn = (new BN(oneToken.toString())).mul(new BN('10019')).div(new BN('10000')); // I just hate javascript
            const yDaiIn = (new BN(yDaiTokens1.toString())).sub(new BN(await yDai1.balanceOf(from)));
            expect(yDaiIn).to.be.bignumber.gt(expectedYDaiIn.mul(new BN('9999')).div(new BN('10000')));
            expect(yDaiIn).to.be.bignumber.lt(expectedYDaiIn.mul(new BN('10001')).div(new BN('10000')));
        });

        it("sells yDai without delegation", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await yDai1.mint(from, oneToken, { from: owner });

            // chaiOutForYDaiIn formula: https://www.desmos.com/calculator/6ylefi7fv7

            assert.equal(
                await dai.balanceOf(to),
                0,
                "'To' wallet should have no dai, instead has " + await dai.balanceOf(to),
            );

            await yDai1.approve(market.address, oneToken, { from: from });
            await market.sellYDai(from, to, oneToken, { from: from });

            assert.equal(
                await yDai1.balanceOf(from),
                0,
                "'From' wallet should have no yDai tokens",
            );

            const expectedDaiOut = (new BN(oneToken.toString())).mul(new BN('99814')).div(new BN('100000')); // I just hate javascript
            const daiOut = new BN(await dai.balanceOf(to));
            expect(daiOut).to.be.bignumber.gt(expectedDaiOut.mul(new BN('9999')).div(new BN('10000')));
            expect(daiOut).to.be.bignumber.lt(expectedDaiOut.mul(new BN('10001')).div(new BN('10000')));
        });

        it("buys yDai without delegation", async() => {
            const b = new BN('18446744073709551615');
            const r = new BN('1000000000000000000000000000');
            const oneToken = toWad(1);
            await getDai(from, daiTokens1);

            // chaiInForYDaiOut formula: https://www.desmos.com/calculator/cgpfpqe3fq

            assert.equal(
                await yDai1.balanceOf(to),
                0,
                "'To' wallet should have no yDai, instead has " + await yDai1.balanceOf(to),
            );

            await dai.approve(market.address, daiTokens1, { from: from });
            await market.buyYDai(from, to, oneToken, { from: from });

            assert.equal(
                await yDai1.balanceOf(to),
                oneToken.toString(),
                "'To' wallet should have 1 yDai token",
            );

            const expectedDaiIn = (new BN(oneToken.toString())).mul(new BN('10019')).div(new BN('10000')); // I just hate javascript
            const daiIn = (new BN(daiTokens1.toString())).sub(new BN(await dai.balanceOf(from)));
            expect(daiIn).to.be.bignumber.gt(expectedDaiIn.mul(new BN('9999')).div(new BN('10000')));
            expect(daiIn).to.be.bignumber.lt(expectedDaiIn.mul(new BN('10001')).div(new BN('10000')));
        });

        // --- ONLY HOLDER OR DELEGATE TESTS ---

        it("sells dai without delegation", async() => {
            await expectRevert(
                market.sellDai(from, to, 1, { from: operator }),
                "Market: Only Holder Or Delegate",
            );
        });

        it("buys dai without delegation", async() => {
            await expectRevert(
                market.buyDai(from, to, 1, { from: operator }),
                "Market: Only Holder Or Delegate",
            );
        });

        it("sells yDai without delegation", async() => {
            await expectRevert(
                market.sellYDai(from, to, 1, { from: operator }),
                "Market: Only Holder Or Delegate",
            );
        });

        it("buys yDai without delegation", async() => {
            await expectRevert(
                market.buyYDai(from, to, 1, { from: operator }),
                "Market: Only Holder Or Delegate",
            );
        });
    });
});