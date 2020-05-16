pragma solidity ^0.6.2;

import "@hq20/contracts/contracts/math/DecimalMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/ILender.sol";
import "./interfaces/ISaver.sol";
import "./interfaces/IYDai.sol";
import "./Constants.sol";
import "@nomiclabs/buidler/console.sol";


/// @dev Mint manages a Dai/yDai pair. Note that Dai is underlying, not collateral, and therefore the functions are minting and redeeming, instead of borrowing and repaying.
contract Mint is Constants {
    using DecimalMath for uint256;

    ILender internal _lender;
    ISaver internal _saver;
    IERC20 internal _dai;
    IYDai internal _yDai;

    constructor (
        address lender_,
        address saver_,
        address dai_,
        address yDai_
    ) public {
        _lender = ILender(lender_);
        _saver = ISaver(saver_);
        _dai = IERC20(dai_);
        _yDai = IYDai(yDai_);
    }

    /// @dev Mint yDai by posting an equal amount of Dai.
    /// If the Lender has debt it is paid, otherwise the dai is converted into chai
    // user --- Dai  ---> us
    // us   --- yDai ---> user
    function mint(address user, uint256 dai) public {
        // TODO: Pay as much debt as possible, and save the rest
        if (_lender.debt() < dai) {
            mintNoDebt(user, dai);
        }
        else {
            mintDebt(user, dai);
        }
    }

    /// @dev Burn yTokens and return an equal amount of underlying.
    /// If the Saver has savings they are used to deliver the dai to the user, otherwise dai is borrowed from MakerDao
    // user --- yDai ---> us
    // us   --- Dai  ---> user
    function redeem(address user, uint256 dai) public {
        require(
            _yDai.isMature(),
            "Mint: yDai is not mature"
        );
        // TODO: Take as much as possible from savings, and borrow the rest
        if (_saver.savings() < dai) {
            redeemNoSavings(user, dai);
        }
        else {
            redeemSavings(user, dai);
        }
    }

    /// @dev Mint yDai assuming there is no debt
    function mintNoDebt(address user, uint256 dai) internal {
        _dai.transferFrom(user, address(this), dai);        // Get the dai from user
        _dai.approve(address(_saver), dai);                 // Saver will take dai
        _saver.hold(address(this), dai);                    // Send dai to Saver
        _yDai.mint(user, dai);                              // Mint yDai to user
    }

    /// @dev Mint yDai assuming there is debt
    function mintDebt(address user, uint256 dai) internal {
        _dai.transferFrom(user, address(this), dai);        // Get the dai from user
        _dai.approve(address(_lender), dai);                // Lender will take the dai
        _lender.repay(address(this), dai);                  // Lender takes dai from Mint to repay debt
        _yDai.mint(user, dai);                              // Mint yDai to user
    }

    /// @dev Redeem yDai assuming there are savings
    function redeemSavings(address user, uint256 yDai) internal {
        _yDai.burn(user, yDai);                             // Burn yDai from user
        _saver.release(user, yDai);                            // Give dai to user, from Saver
    }

    /// @dev Redeem yDai assuming there are no savings
    function redeemNoSavings(address user, uint256 yDai) internal {
        _yDai.burn(user, yDai);                             // Burn yDai from user
        _lender.borrow(user, yDai);                         // Borrow Dai from Lender to user
    }
}