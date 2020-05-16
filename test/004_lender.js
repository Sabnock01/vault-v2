const Lender = artifacts.require('./Lender');
const ERC20 = artifacts.require("./TestERC20");
const DaiJoin = artifacts.require('DaiJoin');
const GemJoin = artifacts.require('./GemJoin');
const Vat= artifacts.require('./Vat');

const truffleAssert = require('truffle-assertions');
const helper = require('ganache-time-traveler');
const { expectRevert } = require('@openzeppelin/test-helpers');

contract('Lender', async (accounts) =>  {
    let [ owner, user ] = accounts;
    let lender;
    let dai;
    let weth;
    let daiJoin;
    let wethJoin;
    let vat;
    const ilk = web3.utils.fromAscii("ETH-A")
    const Line = web3.utils.fromAscii("Line")
    const spotName = web3.utils.fromAscii("spot")
    const linel = web3.utils.fromAscii("line")

    const RAY  = "1000000000000000000000000000";
    const RAD = web3.utils.toBN('45');
    const supply = web3.utils.toWei("1000");
    const limits =  web3.utils.toBN('10000').mul(web3.utils.toBN('10').pow(RAD)).toString(); // 10000 * 10**45

    const spot  = "1500000000000000000000000000";
    const rate  = "1250000000000000000000000000";
    const daiDebt = web3.utils.toWei("120");    // Dai debt for `frob`: 120
    const wethTokens = web3.utils.toWei("100"); // Collateral we join: 120 * rate / spot
    const daiTokens = web3.utils.toWei("150");  // Dai we can borrow: 120 * rate

    beforeEach(async() => {
        // Set up vat, join and weth
        vat = await Vat.new();
        await vat.rely(vat.address, { from: owner });

        weth = await ERC20.new(0, { from: owner }); 
        await vat.init(ilk, { from: owner }); // Set ilk rate to 1.0
        wethJoin = await GemJoin.new(vat.address, ilk, weth.address, { from: owner });
        await vat.rely(wethJoin.address, { from: owner });

        dai = await ERC20.new(0, { from: owner });
        daiJoin = await DaiJoin.new(vat.address, dai.address, { from: owner });
        await vat.rely(daiJoin.address, { from: owner });

        // Setup vat
        await vat.file(ilk, spotName, spot, { from: owner });
        await vat.file(ilk, linel, limits, { from: owner });
        await vat.file(Line, limits); // TODO: Why can't we specify `, { from: owner }`?

        lender = await Lender.new(
            dai.address,        // dai
            weth.address,       // weth
            daiJoin.address,    // daiJoin
            wethJoin.address,   // wethJoin
            vat.address,        // vat
        );
        await lender.grantAccess(user, { from: owner });

        const rateIncrease  = "250000000000000000000000000";
        await vat.fold(ilk, vat.address, rateIncrease, { from: owner }); // 1 + 0.25
    });
    
    it("should fail for failed weth transfers", async() => {
        // Let's check how WETH is implemented, maybe we can remove this one.
    });

    it("allows user to post collateral", async() => {
        assert.equal(
            (await weth.balanceOf(wethJoin.address)),   
            web3.utils.toWei("0")
        );
        
        await weth.mint(user, wethTokens, { from: user });
        await weth.approve(lender.address, wethTokens, { from: user }); 
        await lender.post(user, wethTokens, { from: user });

        // Test transfer of collateral
        assert.equal(
            await weth.balanceOf(wethJoin.address),   
            wethTokens,
        );

        // Test collateral registering via `frob`
        assert.equal(
            (await vat.urns(ilk, lender.address)).ink,   
            wethTokens,
        );
    });

    describe("with posted collateral", () => {
        beforeEach(async() => {
            await weth.mint(user, wethTokens, { from: user });
            await weth.approve(lender.address, wethTokens, { from: user }); 
            await lender.post(user, wethTokens, { from: user });
        });

        it("returns borrowing power", async() => {
            assert.equal(
                await lender.power(),   
                daiTokens,
                "Should return posted collateral * collateralization ratio"
            );
        });

        it("allows user to withdraw collateral", async() => {
            assert.equal(
                await weth.balanceOf(user),   
                0,
            );
            
            await lender.withdraw(user, wethTokens, { from: user });

            // Test transfer of collateral
            assert.equal(
                (await weth.balanceOf(user)),   
                wethTokens,
            );

            // Test collateral registering via `frob`
            assert.equal(
                (await vat.urns(ilk, lender.address)).ink,   
                0
            );
        });

        it("allows to borrow dai", async() => {
            // Test with two different stability rates, if possible.
            // Mock Vat contract needs a `setRate` and an `ilks` functions.
            // Mock Vat contract needs the `frob` function to authorize `daiJoin.exit` transfers through the `dart` parameter.
            await lender.borrow(user, daiTokens, { from: user });

            assert.equal(
                await dai.balanceOf(user),   
                daiTokens
            );
            assert.equal(
                (await vat.urns(ilk, lender.address)).art,   
                daiDebt,
            );
        });


        it("shouldn't allow borrowing beyond power", async() => {
            await lender.borrow(user, daiTokens, { from: user });
            assert.equal(
                await lender.power(),   
                daiTokens,
                "We should have " + daiTokens + " dai borrowing power.",
            );
            assert.equal(
                await lender.debt(),   
                daiTokens,
                "We should have " + daiTokens + " dai debt.",
            );
            await expectRevert(
                lender.borrow(user, 1, { from: user }), // Not a wei more borrowing
                "Vat/sub",
            );
        });
    
        describe("with a dai debt towards MakerDAO", () => {
            beforeEach(async() => {
                await lender.borrow(user, daiTokens, { from: user });
            });

            it("returns lender debt", async() => {
                assert.equal(
                    (await lender.debt()),   
                    daiTokens,
                    "Should return borrowed dai"
                );
            });

            it("repays dai debt and no more", async() => {
                // Test `normalizedAmount >= normalizedDebt`
                await dai.approve(lender.address, daiTokens, { from: user });
                await lender.repay(user, daiTokens, { from: user });

                assert.equal(
                    await dai.balanceOf(user),   
                    0
                );
                assert.equal(
                    (await vat.urns(ilk, lender.address)).art,   
                    0,
                );
                assert.equal(
                    await vat.dai(lender.address),   
                    0
                );

                // Test `normalizedAmount < normalizedDebt`
                // Mock Vat contract needs to return `normalizedDebt` with a `urns` function
                // The DaiJoin mock contract needs to have a `join` function that authorizes Vat for incoming dai transfers.
                // The DaiJoin mock contract needs to have a function to return it's dai balance.
                // The Vat mock contract needs to have a frob function that takes `dart` dai from user to DaiJoin
                // Should transfer funds from daiJoin
            });
        });
    });
});